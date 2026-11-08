import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { defineTool } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { verifiedProjectCommandIds } from "./project-commands.mjs";

export const WORKSPACE_LIMITS = Object.freeze({
  maxFileBytes: 1024 * 1024,
  maxCommandOutputBytes: 64 * 1024,
  commandTimeoutMs: 30_000,
  commandKillGraceMs: 250,
});
const MAX_COMMAND_TIMEOUT_MS = 300_000;

function exactKeys(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new Error("Invalid workspace permissions");
  }
}

export function validatePermissions(value) {
  exactKeys(value, ["read", "write", "commands"]);
  if (
    typeof value.read !== "boolean" ||
    typeof value.write !== "boolean" ||
    !Array.isArray(value.commands) ||
    value.commands.length > 32
  ) {
    throw new Error("Workspace read, write and commands permissions must be explicit");
  }
  const ids = new Set();
  const commands = value.commands.map((command) => {
    exactKeys(command, ["id", "program", "args", "timeoutMs"]);
    if (
      typeof command.id !== "string" ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(command.id) ||
      ids.has(command.id) ||
      typeof command.program !== "string" ||
      !isAbsolute(command.program) ||
      command.program.includes("\0") ||
      !Array.isArray(command.args) ||
      command.args.length > 128 ||
      command.args.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
      (Object.hasOwn(command, "timeoutMs") &&
        (!Number.isSafeInteger(command.timeoutMs) ||
          command.timeoutMs < 1 ||
          command.timeoutMs > MAX_COMMAND_TIMEOUT_MS))
    ) {
      throw new Error("Invalid or duplicate configured workspace command");
    }
    ids.add(command.id);
    return Object.freeze({
      id: command.id,
      program: command.program,
      args: Object.freeze([...command.args]),
      ...(Object.hasOwn(command, "timeoutMs") ? { timeoutMs: command.timeoutMs } : {}),
    });
  });
  return Object.freeze({
    read: value.read,
    write: value.write,
    commands: Object.freeze(commands),
  });
}

const inside = (root, path) => path === root || path.startsWith(root + sep);
const text = (value, details) => ({
  output: [{ type: "text", text: value }],
  ...(details ? { details } : {}),
});
const abort = (signal) => {
  if (signal?.aborted) throw new Error("Workspace operation was cancelled");
};

async function futureRealpath(path) {
  let parent = resolve(path);
  const suffix = [];
  while (true) {
    try {
      return resolve(await realpath(parent), ...suffix.reverse());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const next = dirname(parent);
      if (next === parent) throw error;
      suffix.push(basename(parent));
      parent = next;
    }
  }
}

/** Cooperative workspace access, not an OS sandbox for configured executables. */
export async function createWorkspaceTools(cwd, permissionValue, options = {}) {
  const permissions = validatePermissions(permissionValue);
  const projectCommands = await verifiedProjectCommandIds(permissions);
  if (typeof cwd !== "string" || !isAbsolute(cwd))
    throw new Error("Workspace must be an absolute directory");
  const root = await realpath(cwd);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error("Workspace must be a directory");
  const excluded = options.sessionDir ? await futureRealpath(options.sessionDir) : null;
  const protectedPaths = await Promise.all((options.protectedPaths ?? []).map(futureRealpath));
  const limits = { ...WORKSPACE_LIMITS, ...options.limits };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error("Invalid workspace operation limit");
  }
  const allowed = new Map();
  for (const command of permissions.commands) {
    const program = await realpath(command.program);
    if (!(await lstat(program)).isFile())
      throw new Error("Configured command must be a regular executable");
    await access(program, constants.X_OK);
    allowed.set(command.id, { ...command, program });
  }
  function check(path, write, allowRoot = false) {
    if (!inside(root, path) || (!allowRoot && path === root))
      throw new Error("Path is outside workspace files");
    if (excluded && inside(excluded, path))
      throw new Error("Worker session storage is not a workspace file");
    if (
      protectedPaths.some(
        (protectedPath) =>
          inside(protectedPath, path) || (write && !allowRoot && inside(path, protectedPath)),
      )
    )
      throw new Error("Provider credential storage is not a workspace file");
    if (write && relative(root, path).split(sep).includes(".git"))
      throw new Error("Git metadata cannot be changed by workspace file tools");
    return path;
  }
  function lexical(path, write = false) {
    if (
      typeof path !== "string" ||
      !path ||
      path.includes("\0") ||
      path.split(/[\\/]/).includes("..")
    )
      throw new Error("Invalid workspace path");
    return check(resolve(root, path), write);
  }
  async function readPath(path) {
    return check(await realpath(lexical(path)), false);
  }
  async function writePath(path, createParents = false) {
    const raw = lexical(path, true);
    try {
      if ((await lstat(raw)).isSymbolicLink())
        throw new Error("Cannot write through a final symlink");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    let parent;
    if (createParents) {
      // Resolve the existing prefix before making any directory. In particular
      // an external/state/Git symlink prefix must be refused before mkdir.
      parent = check(await futureRealpath(dirname(raw)), true, true);
      await mkdir(parent, { recursive: true });
      parent = check(await realpath(parent), true, true);
    } else {
      parent = await realpath(dirname(raw));
    }
    return check(join(parent, basename(raw)), true);
  }
  async function readBounded(path) {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > limits.maxFileBytes)
        throw new Error("Workspace file exceeds text-file limit");
      const buffer = Buffer.alloc(limits.maxFileBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const read = await handle.read(buffer, size, buffer.length - size, size);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size > limits.maxFileBytes) throw new Error("Workspace file exceeds text-file limit");
      return {
        content: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)),
        stat,
      };
    } finally {
      await handle.close();
    }
  }
  let mutations = Promise.resolve();
  function mutate(operation) {
    const run = mutations.then(operation);
    mutations = run.catch(() => {});
    return run;
  }
  async function publish(path, content, expected, signal) {
    abort(signal);
    if (typeof content !== "string" || Buffer.byteLength(content) > limits.maxFileBytes)
      throw new Error("Workspace content exceeds text-file limit");
    let previous;
    try {
      previous = await readBounded(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (previous ? expected === undefined || previous.content !== expected : expected !== undefined)
      throw new Error("Workspace file changed; expectedContent must match before overwrite");
    const temp = join(dirname(path), `.yori-write-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      if (previous) await handle.chmod(previous.stat.mode & 0o777);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      abort(signal);
      if ((await writePath(path)) !== path)
        throw new Error("Workspace parent changed before write");
      if (previous) {
        const current = await readBounded(path);
        if (
          current.content !== expected ||
          current.stat.ino !== previous.stat.ino ||
          current.stat.dev !== previous.stat.dev
        )
          throw new Error("Workspace file changed before write");
        await rename(temp, path);
      } else {
        // Exclusive publication never overwrites a file another writer created.
        await link(temp, path);
      }
    } finally {
      await handle?.close();
      await unlink(temp).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    return text(`Wrote ${relative(root, path)}`, {
      bytes: Buffer.byteLength(content),
    });
  }
  const tools = [];
  if (permissions.read)
    tools.push(
      defineTool({
        name: "read_file",
        description:
          "Read a bounded UTF-8 file inside the workspace; worker session storage is excluded.",
        parameters: obj({ path: str() }),
        replay: "safe",
        execute: async ({ path }, _api, context) => {
          abort(context?.abortSignal);
          const selected = await readPath(path);
          const result = await readBounded(selected);
          return text(result.content, {
            path: relative(root, selected),
            bytes: Buffer.byteLength(result.content),
          });
        },
      }),
    );
  if (permissions.write) {
    tools.push(
      defineTool({
        name: "write_file",
        description:
          "Create a workspace UTF-8 file and missing parent directories; overwriting requires its exact expectedContent. No Git metadata or final symlinks.",
        parameters: obj({
          path: str(),
          content: str(),
          expectedContent: opt(str()),
        }),
        replay: "unsafe",
        executionMode: "sequential",
        execute: ({ path, content, expectedContent }, _api, context) =>
          mutate(async () => {
            abort(context?.abortSignal);
            if (typeof content !== "string" || Buffer.byteLength(content) > limits.maxFileBytes)
              throw new Error("Workspace content exceeds text-file limit");
            return publish(
              await writePath(path, expectedContent === undefined),
              content,
              expectedContent,
              context?.abortSignal,
            );
          }),
      }),
    );
    tools.push(
      defineTool({
        name: "edit_file",
        description:
          "Replace one exact occurrence of oldText in a workspace UTF-8 file. Reject missing or ambiguous matches.",
        parameters: obj({
          path: str(),
          oldText: str({ minLength: 1 }),
          newText: str(),
        }),
        replay: "unsafe",
        executionMode: "sequential",
        execute: ({ path, oldText, newText }, _api, context) =>
          mutate(async () => {
            abort(context?.abortSignal);
            const selected = await writePath(path);
            const { content } = await readBounded(selected);
            if (!oldText || content.split(oldText).length !== 2)
              throw new Error("Edit must match exactly one occurrence");
            return publish(
              selected,
              content.replace(oldText, () => newText),
              content,
              context?.abortSignal,
            );
          }),
      }),
    );
  }
  if (allowed.size)
    tools.push(
      defineTool({
        name: "run_command",
        description: `Run one configured command with fixed executable and argv, never a model-supplied shell command. IDs: ${[...allowed.keys()].join(", ")}`,
        parameters: obj({ commandId: str() }),
        replay: "unsafe",
        executionMode: "sequential",
        execute: async ({ commandId }, _api, context) => {
          abort(context?.abortSignal);
          const command = allowed.get(commandId);
          if (!command) throw new Error("Command ID is not permitted");
          return new Promise((resolveCommand, rejectCommand) => {
            const detached = process.platform !== "win32";
            const child = spawn(command.program, command.args, {
              cwd: root,
              shell: false,
              detached,
              env: {
                PATH: process.env.PATH ?? "/usr/bin:/bin",
                LANG: "C.UTF-8",
                ...(projectCommands.has(commandId) && process.env.CARGO_TARGET_DIR
                  ? { CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR }
                  : {}),
              },
              stdio: ["ignore", "pipe", "pipe"],
            });
            let output = Buffer.alloc(0);
            let failure;
            let closed = false;
            let killTimer;
            const kill = (signal) => {
              if (closed || !child.pid) return;
              try {
                if (detached) process.kill(-child.pid, signal);
                else child.kill(signal);
              } catch (error) {
                if (error.code !== "ESRCH") failure ??= error;
              }
            };
            const fail = (message) => {
              failure ??= new Error(message);
              kill("SIGTERM");
              killTimer ??= setTimeout(() => kill("SIGKILL"), limits.commandKillGraceMs);
            };
            const onAbort = () => fail("Configured command was cancelled");
            const timer = setTimeout(
              () => fail("Configured command exceeded its deadline"),
              command.timeoutMs ?? limits.commandTimeoutMs,
            );
            const collect = (chunk) => {
              if (output.length + chunk.length > limits.maxCommandOutputBytes) {
                fail("Configured command exceeded its output limit");
                return;
              }
              output = Buffer.concat([output, chunk]);
            };
            child.stdout.on("data", collect);
            child.stderr.on("data", collect);
            child.once("error", (error) => {
              failure ??= error;
            });
            child.once("close", (code, signal) => {
              closed = true;
              clearTimeout(timer);
              clearTimeout(killTimer);
              context?.abortSignal?.removeEventListener("abort", onAbort);
              if (failure) rejectCommand(failure);
              else if (code !== 0)
                rejectCommand(
                  new Error(
                    `Configured command failed (${code ?? signal}): ${output.toString("utf8")}`,
                  ),
                );
              else {
                let result = output.toString("utf8");
                if (commandId === "workspace-info") {
                  try {
                    const info = JSON.parse(result);
                    if (info.check === "workspace-info")
                      result = JSON.stringify({
                        ...info,
                        grantedCommandPresets: [...allowed.keys()],
                        fileCapabilities: { read: permissions.read, write: permissions.write },
                      });
                  } catch {
                    /* 既存の独自コマンドの出力は変更しない。 */
                  }
                }
                resolveCommand(text(result, { commandId, exitCode: code }));
              }
            });
            context?.abortSignal?.addEventListener("abort", onAbort, {
              once: true,
            });
            if (context?.abortSignal?.aborted) onAbort();
          });
        },
      }),
    );
  return tools;
}

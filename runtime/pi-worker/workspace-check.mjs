import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMMAND_PRESET_IDS,
  projectCapabilities,
  runDevelopmentCommand,
} from "./project-commands.mjs";
import { workspaceRepository } from "./workspace-repository.mjs";

const EXCLUDED = new Set([
  ".git",
  ".yorishiro",
  ".charminal",
  "node_modules",
  "target",
  ".DS_Store",
]);
const LIMITS = Object.freeze({
  entries: 2048,
  jsonFiles: 128,
  fileBytes: 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
  depth: 6,
});

/** Fixed built-in project checks. No shell, provider access or file writes. */
export async function inspectWorkspace(action, directory = process.cwd()) {
  if (!["workspace-info", "validate-json"].includes(action))
    throw new Error("workspace_check_invalid");
  const root = await realpath(directory);
  if (!(await lstat(root)).isDirectory()) throw new Error("workspace_check_unavailable");
  let entries = 0;
  let bytes = 0;
  let complete = true;
  let excludedSymlinks = 0;
  const files = [];
  const items = [];
  async function walk(parent, depth) {
    const names = (await readdir(parent)).sort();
    for (const name of names) {
      if (EXCLUDED.has(name)) continue;
      if (++entries > LIMITS.entries) {
        complete = false;
        return;
      }
      const path = join(parent, name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        excludedSymlinks += 1;
        continue;
      }
      const local = relative(root, path);
      if (action === "workspace-info") {
        if (items.length >= 64) {
          complete = false;
          return;
        }
        items.push({
          name: local,
          kind: metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : "other",
        });
        continue;
      }
      if (metadata.isDirectory()) {
        if (depth >= LIMITS.depth) {
          complete = false;
          continue;
        }
        await walk(path, depth + 1);
        if (entries > LIMITS.entries) return;
      } else if (metadata.isFile() && name.endsWith(".json")) {
        if (
          files.length >= LIMITS.jsonFiles ||
          metadata.size > LIMITS.fileBytes ||
          bytes + metadata.size > LIMITS.totalBytes
        ) {
          complete = false;
          continue;
        }
        // A concurrent append cannot allocate beyond the fixed per-file limit.
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        let body;
        try {
          const buffer = Buffer.alloc(Math.min(metadata.size + 1, LIMITS.fileBytes + 1));
          const result = await file.read(buffer, 0, buffer.length, 0);
          body = buffer.subarray(0, result.bytesRead);
        } finally {
          await file.close();
        }
        if (body.length > metadata.size || body.length > LIMITS.fileBytes) {
          complete = false;
          continue;
        }
        bytes += body.length;
        let valid = false;
        try {
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
          valid = true;
        } catch {
          /* Never echo file content or parse errors. */
        }
        files.push({ name: local, valid });
      }
    }
  }
  await walk(root, 0);
  return action === "workspace-info"
    ? {
        check: action,
        complete,
        excludedSymlinks,
        items,
        cwd: root,
        repository: await workspaceRepository(root),
        supportedCommandPresets: COMMAND_PRESET_IDS,
        project: await projectCapabilities(root).catch(() => ({
          kind: "unavailable",
          availableCommands: [],
        })),
        note: "Repository information describes the current selected folder. Worktrees are optional unless the user or remembered project instructions request one. Supported and available commands are not permission grants.",
      }
    : {
        check: action,
        complete,
        excludedSymlinks,
        files,
        invalidFiles: files.filter((file) => !file.valid).length,
      };
}

async function isCommandEntry() {
  try {
    return process.argv[1]
      ? (await realpath(fileURLToPath(import.meta.url))) === (await realpath(process.argv[1]))
      : false;
  } catch {
    return false;
  }
}

if (await isCommandEntry()) {
  try {
    if (process.argv.length !== 3) throw new Error("workspace_check_invalid");
    if (
      COMMAND_PRESET_IDS.includes(process.argv[2]) &&
      !["workspace-info", "validate-json"].includes(process.argv[2])
    ) {
      await runDevelopmentCommand(process.argv[2], await realpath(process.cwd()));
    } else {
      const result = await inspectWorkspace(process.argv[2]);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = !result.complete ? 2 : result.invalidFiles > 0 ? 1 : 0;
    }
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ code: "workspace_check_unavailable", message: String(error.message).slice(0, 512) })}\n`,
    );
    process.exitCode = 2;
  }
}

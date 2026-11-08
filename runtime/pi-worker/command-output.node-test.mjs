import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  COMMAND_OUTPUT_LIMITS,
  createCommandOutput,
  createCommandOutputStore,
} from "./command-output.mjs";
import { createWorkspaceTools } from "./workspace-tools.mjs";

async function fixture(t, code, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "yorishiro-command-output-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  const sessionDir = join(root, "session");
  await mkdir(cwd);
  await mkdir(sessionDir, { mode: 0o700 });
  const permissions = {
    read: false,
    write: false,
    commands: [{ id: "verify", program: process.execPath, args: ["-e", code] }],
  };
  const tools = await createWorkspaceTools(cwd, permissions, {
    sessionDir,
    limits: { maxCommandOutputBytes: 128 },
    ...options,
  });
  const call = (name, args, signal) =>
    tools.find((tool) => tool.name === name).execute(args, {}, { abortSignal: signal });
  return { root, cwd, sessionDir, permissions, tools, call };
}
const chunks = (size = 100000) =>
  `process.stdout.write('BEGIN\\n'+'x'.repeat(${size})+'\\nFINAL DIAGNOSTIC\\n',()=>{require('node:fs').writeFileSync('completed','yes');process.exit(EXITCODE)})`;

for (const code of [0, 23]) {
  test(`large command output preserves final exit ${code}, completion, head/tail and owned logs`, async (t) => {
    const f = await fixture(t, chunks().replace("EXITCODE", String(code)));
    let result;
    if (code === 0) result = await f.call("run_command", { commandId: "verify" });
    else {
      const error = await f.call("run_command", { commandId: "verify" }).catch((error) => error);
      assert.match(error.message, /Configured command failed \(23\)/);
      result = { output: [{ text: error.message }], details: error.details };
    }
    assert.equal(result.details.exitCode, code);
    assert.equal(result.details.completedSuccessfully, code === 0);
    assert.equal(result.details.outputBytes, 100024);
    assert.equal(result.details.truncated, true);
    assert.equal(result.details.logTruncated, false);
    assert.match(result.details.logId, /^[0-9a-f-]{36}$/);
    assert.match(result.output[0].text, /BEGIN/);
    assert.match(result.output[0].text, /FINAL DIAGNOSTIC/);
    assert.match(result.output[0].text, /command output omitted/);
    assert.ok(result.output[0].text.length < 1000);
    assert.equal(await readFile(join(f.cwd, "completed"), "utf8"), "yes");
    const beginning = await f.call("read_command_output", { logId: result.details.logId });
    assert.equal(beginning.details.offset, 0);
    assert.equal(beginning.details.nextOffset, COMMAND_OUTPUT_LIMITS.maxReadBytes);
    assert.match(beginning.output[0].text, /BEGIN/);
    const ending = await f.call("read_command_output", { logId: result.details.logId, tail: true });
    assert.match(ending.output[0].text, /FINAL DIAGNOSTIC/);
    assert.equal(ending.details.nextOffset, result.details.outputBytes);
    assert.equal(ending.details.completedSuccessfully, code === 0);
    const path = join(f.sessionDir, "command-logs", `${result.details.logId}.log`);
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(join(f.sessionDir, "command-logs"))).mode & 0o777, 0o700);
    }
  });
}

test("disk log cap retains a prefix and actual final tail with explicit omitted-middle offsets", async (t) => {
  const f = await fixture(t, chunks(20 * 1024 * 1024).replace("EXITCODE", "0"));
  const result = await f.call("run_command", { commandId: "verify" });
  assert.equal(result.details.exitCode, 0);
  assert.equal(result.details.logTruncated, true);
  const stored = join(f.sessionDir, "command-logs", `${result.details.logId}.log`);
  assert.equal((await stat(stored)).size, COMMAND_OUTPUT_LIMITS.maxLogBytes);
  const end = await f.call("read_command_output", { logId: result.details.logId, tail: true });
  assert.equal(end.details.logTruncated, true);
  assert.equal(end.details.tailBytes, 64);
  assert.equal(end.details.prefixBytes + end.details.tailBytes, end.details.storedBytes);
  assert.match(end.output[0].text, /omitted middle.*Offsets refer to stored bytes/);
  assert.match(end.output[0].text, /FINAL DIAGNOSTIC/);
});

test("ordinary small stdout stays unchanged with session logging, including workspace-info JSON", async (t) => {
  const f = await fixture(t, "process.stdout.write('small output\\n')");
  const small = await f.call("run_command", { commandId: "verify" });
  assert.equal(small.output[0].text, "small output\n");
  assert.equal(small.details.truncated, false);
  assert.ok(small.details.logId);
  const helper = fileURLToPath(new URL("./workspace-check.mjs", import.meta.url));
  const tools = await createWorkspaceTools(
    f.cwd,
    {
      read: false,
      write: false,
      commands: [
        { id: "workspace-info", program: process.execPath, args: [helper, "workspace-info"] },
      ],
    },
    { sessionDir: f.sessionDir },
  );
  const info = await tools
    .find(({ name }) => name === "run_command")
    .execute({ commandId: "workspace-info" }, {}, {});
  assert.equal(JSON.parse(info.output[0].text).check, "workspace-info");
  assert.equal(info.output[0].text.includes("command_output"), false);
  assert.ok(info.details.logId);
});

test("output reading is bounded, UUID-only, session-owned and requires the current command grant", async (t) => {
  const f = await fixture(t, chunks().replace("EXITCODE", "0"));
  const result = await f.call("run_command", { commandId: "verify" });
  const logId = result.details.logId;
  for (const args of [
    { logId: "../auth.json" },
    { logId, offset: -1 },
    { logId, offset: 0.5 },
    { logId, offset: Number.MAX_SAFE_INTEGER },
    { logId, offset: 0, tail: true },
    { logId, path: "auth.json" },
  ]) {
    await assert.rejects(f.call("read_command_output", args), /command_output_unavailable/);
  }
  const other = await createWorkspaceTools(
    f.cwd,
    {
      read: false,
      write: false,
      commands: [{ id: "other", program: process.execPath, args: ["-e", "0"] }],
    },
    { sessionDir: f.sessionDir },
  );
  await assert.rejects(
    other.find(({ name }) => name === "read_command_output").execute({ logId }, {}, {}),
    /command_output_unavailable/,
  );
  const logs = join(f.sessionDir, "command-logs");
  const privateFile = join(f.root, "private");
  await writeFile(privateFile, "PRIVATE_CREDENTIAL", { mode: 0o600 });
  for (const extension of ["log", "json"]) {
    const path = join(logs, `${logId}.${extension}`);
    const original = await readFile(path);
    await unlink(path);
    await symlink(privateFile, path);
    await assert.rejects(
      f.call("read_command_output", { logId }),
      (error) => error.message === "command_output_unavailable",
    );
    await unlink(path);
    await writeFile(path, original, { mode: 0o600 });
  }
});

test("log quotas prune old results while active command reservations remain bounded", async (t) => {
  const f = await fixture(t, "process.stdout.write('x'.repeat(9000))", {
    commandOutputLimits: {
      maxLogBytes: 8192,
      maxSessionBytes: 24576,
      maxLogs: 2,
      maxReadBytes: 64,
    },
  });
  const ids = [];
  for (let index = 0; index < 4; index++)
    ids.push((await f.call("run_command", { commandId: "verify" })).details.logId);
  const names = await readdir(join(f.sessionDir, "command-logs"));
  assert.equal(names.filter((name) => name.endsWith(".log")).length, 2);
  const sizes = await Promise.all(
    names.map(async (name) => (await stat(join(f.sessionDir, "command-logs", name))).size),
  );
  assert.ok(sizes.reduce((a, b) => a + b, 0) <= 24576);
  await assert.rejects(
    f.call("read_command_output", { logId: ids[0] }),
    /command_output_unavailable/,
  );
  const current = await f.call("read_command_output", { logId: ids.at(-1), tail: true });
  assert.equal(current.details.nextOffset - current.details.offset, 64);
  const reservedDir = join(f.root, "reserved");
  await mkdir(reservedDir, { mode: 0o700 });
  const store = createCommandOutputStore(reservedDir, ["verify"], {
    maxLogBytes: 8192,
    maxSessionBytes: 24576,
  });
  const first = store.start("verify");
  const second = store.start("verify");
  assert.throws(() => store.start("verify"), /command_output_unavailable/);
  first.finish({ outputBytes: 0, exitCode: 0, signal: null, truncated: false }, Buffer.alloc(0));
  second.finish({ outputBytes: 0, exitCode: 0, signal: null, truncated: false }, Buffer.alloc(0));
});

test("unsafe/unavailable log storage never loses command completion or its real exit code", async (t) => {
  const f = await fixture(t, "process.stdout.write('completed');process.exit(17)");
  const outside = join(f.root, "outside");
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, join(f.sessionDir, "command-logs"));
  const error = await f.call("run_command", { commandId: "verify" }).catch((error) => error);
  assert.equal(error.details.exitCode, 17);
  assert.equal(error.details.logUnavailable, true);
  assert.equal(error.details.logId, null);
  assert.match(error.message, /completed/);
  assert.deepEqual(await readdir(outside), []);
  const capture = createCommandOutput(32, "verify", {
    start: () => ({
      append() {},
      finish() {
        throw new Error("disk failure");
      },
    }),
  });
  capture.append(Buffer.from("still completed"));
  assert.equal(capture.finish(0, null).details.exitCode, 0);
});

test("large legacy output without sessionDir is summarized without a log or new tool", async (t) => {
  const f = await fixture(t, chunks().replace("EXITCODE", "0"), { sessionDir: undefined });
  const result = await f.call("run_command", { commandId: "verify" });
  assert.equal(result.details.logId, null);
  assert.equal(result.details.exitCode, 0);
  assert.equal(result.details.truncated, true);
  assert.equal(
    f.tools.some(({ name }) => name === "read_command_output"),
    false,
  );
});

test("a cancelled legacy command that exits zero remains unsuccessful in its persisted log", {
  skip: process.platform === "win32",
}, async (t) => {
  const f = await fixture(
    t,
    "process.on('SIGTERM',()=>process.exit(0));require('node:fs').writeFileSync('ready','yes');setInterval(()=>{},1000)",
  );
  const controller = new AbortController();
  const running = f
    .call("run_command", { commandId: "verify" }, controller.signal)
    .catch((error) => error);
  const deadline = Date.now() + 5000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    ready = await readFile(join(f.cwd, "ready")).then(
      () => true,
      () => false,
    );
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(ready, true);
  controller.abort();
  const error = await running;
  assert.match(error.message, /cancelled/);
  assert.equal(error.details.exitCode, 0);
  assert.equal(error.details.signal, null);
  assert.equal(error.details.completedSuccessfully, false);
  const log = await f.call("read_command_output", { logId: error.details.logId });
  assert.equal(log.details.exitCode, 0);
  assert.equal(log.details.signal, null);
  assert.equal(log.details.completedSuccessfully, false);
});

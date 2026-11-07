import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorkspaceTools, validatePermissions, WORKSPACE_LIMITS } from "./workspace-tools.mjs";

const policy = (change = {}) => ({ read: true, write: true, commands: [], ...change });
async function fixture(change, options) {
  const base = await mkdtemp(join(tmpdir(), "yorishiro-workspace-tools-"));
  const cwd = join(base, "workspace");
  await mkdir(cwd);
  const tools = await createWorkspaceTools(cwd, policy(change), options);
  const call = (name, args, signal) => {
    const tool = tools.find((value) => value.name === name);
    if (!tool) throw new Error("Tool was not registered");
    return tool.execute(args, {}, { abortSignal: signal });
  };
  return { base, cwd, tools, call };
}

test("permissions are explicit and fixed commands reject unknown fields and duplicate IDs", () => {
  for (const value of [
    undefined,
    {},
    { read: true, write: false },
    { ...policy(), shell: true },
    policy({ commands: [{ id: "x", program: "node", args: [] }] }),
    policy({ commands: [{ id: "x", program: process.execPath, args: [], env: {} }] }),
    policy({
      commands: [
        { id: "x", program: process.execPath, args: [] },
        { id: "x", program: process.execPath, args: [] },
      ],
    }),
  ]) {
    assert.throws(() => validatePermissions(value));
  }
  const source = policy({
    commands: [{ id: "test", program: process.execPath, args: ["--version"] }],
  });
  const checked = validatePermissions(source);
  source.commands[0].args.push("modified");
  assert.deepEqual(checked.commands[0].args, ["--version"]);
  assert.equal(Object.isFrozen(checked.commands[0].args), true);
});

test("command deadlines preserve legacy identity and accept only explicit bounded host values", () => {
  const legacy = policy({
    commands: [{ id: "check", program: process.execPath, args: ["--version"] }],
  });
  assert.equal(WORKSPACE_LIMITS.commandTimeoutMs, 30_000);
  assert.equal(JSON.stringify(validatePermissions(legacy)), JSON.stringify(legacy));
  assert.equal(Object.hasOwn(validatePermissions(legacy).commands[0], "timeoutMs"), false);
  for (const timeoutMs of [1, 120_000, 300_000]) {
    const explicit = { ...legacy.commands[0], timeoutMs };
    assert.deepEqual(validatePermissions(policy({ commands: [explicit] })).commands[0], explicit);
  }
  for (const timeoutMs of [
    null,
    undefined,
    0,
    -1,
    0.5,
    300_001,
    "120000",
    true,
    {},
    NaN,
    Infinity,
  ]) {
    assert.throws(() =>
      validatePermissions(
        policy({
          commands: [{ ...legacy.commands[0], timeoutMs }],
        }),
      ),
    );
  }
});

test("real file create, guarded overwrite and exact edit preserve content on stale input", async () => {
  const f = await fixture();
  await f.call("write_file", { path: "result.txt", content: "first value\n" });
  assert.equal((await f.call("read_file", { path: "result.txt" })).output[0].text, "first value\n");
  await assert.rejects(
    f.call("write_file", { path: "result.txt", content: "bad" }),
    /expectedContent/,
  );
  await writeFile(join(f.cwd, "result.txt"), "user changed it\n");
  await assert.rejects(
    f.call("write_file", { path: "result.txt", content: "bad", expectedContent: "first value\n" }),
    /changed/,
  );
  assert.equal(await readFile(join(f.cwd, "result.txt"), "utf8"), "user changed it\n");
  await f.call("edit_file", { path: "result.txt", oldText: "user changed", newText: "verified" });
  assert.equal(await readFile(join(f.cwd, "result.txt"), "utf8"), "verified it\n");
  await writeFile(join(f.cwd, "ambiguous.txt"), "same same");
  await assert.rejects(
    f.call("edit_file", { path: "ambiguous.txt", oldText: "same", newText: "x" }),
    /exactly one/,
  );
  assert.equal(await readFile(join(f.cwd, "ambiguous.txt"), "utf8"), "same same");
  const mode = (await stat(join(f.cwd, "result.txt"))).mode & 0o777;
  await f.call("write_file", {
    path: "result.txt",
    content: "last",
    expectedContent: "verified it\n",
  });
  assert.equal((await stat(join(f.cwd, "result.txt"))).mode & 0o777, mode);
  assert.equal(
    (await readdir(f.cwd)).some((name) => name.startsWith(".yori-write-")),
    false,
  );
  const readOnly = await createWorkspaceTools(f.cwd, policy({ write: false }));
  assert.deepEqual(
    readOnly.map((tool) => tool.name),
    ["read_file"],
  );
});

test("workspace escapes, external symlinks, final symlink writes, Git writes and worker state are refused", async () => {
  const f = await fixture();
  await writeFile(join(f.base, "outside.txt"), "outside sentinel");
  await symlink(join(f.base, "outside.txt"), join(f.cwd, "outside-link"));
  await assert.rejects(f.call("read_file", { path: "../outside.txt" }), /path|workspace/i);
  await assert.rejects(f.call("read_file", { path: "outside-link" }), /workspace/);
  await assert.rejects(
    f.call("write_file", { path: "outside-link", content: "changed" }),
    /symlink/,
  );
  await writeFile(join(f.cwd, "inside.txt"), "inside");
  await symlink(join(f.cwd, "inside.txt"), join(f.cwd, "inside-link"));
  assert.equal((await f.call("read_file", { path: "inside-link" })).output[0].text, "inside");
  await assert.rejects(
    f.call("write_file", { path: "inside-link", content: "changed", expectedContent: "inside" }),
    /symlink/,
  );
  await mkdir(join(f.cwd, ".git"));
  await assert.rejects(
    f.call("write_file", { path: ".git/config", content: "bad" }),
    /Git metadata/,
  );
  const sessionDir = join(f.cwd, "state");
  await mkdir(sessionDir);
  await writeFile(join(sessionDir, "session.sqlite"), "private worker state");
  await symlink(sessionDir, join(f.cwd, "state-alias"));
  const stateTools = await createWorkspaceTools(f.cwd, policy(), { sessionDir });
  const read = stateTools.find((tool) => tool.name === "read_file");
  const write = stateTools.find((tool) => tool.name === "write_file");
  await assert.rejects(read.execute({ path: "state/session.sqlite" }, {}, {}), /session storage/);
  await assert.rejects(
    read.execute({ path: "state-alias/session.sqlite" }, {}, {}),
    /session storage/,
  );
  await assert.rejects(
    write.execute({ path: "state/new.txt", content: "x" }, {}, {}),
    /session storage/,
  );
  assert.equal(await readFile(join(f.base, "outside.txt"), "utf8"), "outside sentinel");
});

test("text size limits and cancellation leave files unchanged", async () => {
  const f = await fixture({}, { limits: { maxFileBytes: 16 } });
  await writeFile(join(f.cwd, "large.txt"), "x".repeat(17));
  await assert.rejects(f.call("read_file", { path: "large.txt" }), /limit/);
  await assert.rejects(
    f.call("write_file", { path: "too-large.txt", content: "x".repeat(17) }),
    /limit/,
  );
  await assert.rejects(access(join(f.cwd, "too-large.txt"), constants.F_OK));
  const cancellation = new AbortController();
  cancellation.abort();
  await assert.rejects(
    f.call("write_file", { path: "cancelled.txt", content: "x" }, cancellation.signal),
    /cancelled/,
  );
  await assert.rejects(access(join(f.cwd, "cancelled.txt"), constants.F_OK));
});

test("nested files create canonical workspace parents but denied paths create no directories", async () => {
  const f = await fixture();
  await f.call("write_file", {
    path: "src/new-module/index.mjs",
    content: "export const value = 1;\n",
  });
  assert.equal(
    await readFile(join(f.cwd, "src/new-module/index.mjs"), "utf8"),
    "export const value = 1;\n",
  );
  await symlink(join(f.cwd, "src"), join(f.cwd, "inside-parent"));
  await f.call("write_file", { path: "inside-parent/another/note.txt", content: "inside" });
  assert.equal(await readFile(join(f.cwd, "src/another/note.txt"), "utf8"), "inside");
  const outside = join(f.base, "outside");
  await mkdir(outside);
  await symlink(outside, join(f.cwd, "outside-parent"));
  await assert.rejects(
    f.call("write_file", { path: "outside-parent/new/child.txt", content: "bad" }),
    /workspace/,
  );
  await assert.rejects(access(join(outside, "new")));
  await assert.rejects(
    f.call("write_file", { path: "../outside/traversal/child.txt", content: "bad" }),
    /path/i,
  );
  await assert.rejects(access(join(outside, "traversal")));
  await mkdir(join(f.cwd, ".git"));
  await symlink(join(f.cwd, ".git"), join(f.cwd, "git-parent"));
  await assert.rejects(
    f.call("write_file", { path: "git-parent/objects/new/file", content: "bad" }),
    /Git metadata/,
  );
  await assert.rejects(access(join(f.cwd, ".git/objects")));
  const sessionDir = join(f.cwd, "worker-state");
  await mkdir(sessionDir);
  await symlink(sessionDir, join(f.cwd, "state-parent"));
  const tools = await createWorkspaceTools(f.cwd, policy(), { sessionDir });
  const write = tools.find((tool) => tool.name === "write_file");
  await assert.rejects(
    write.execute({ path: "worker-state/blocked/file", content: "bad" }, {}, {}),
    /session storage/,
  );
  await assert.rejects(
    write.execute({ path: "state-parent/blocked/file", content: "bad" }, {}, {}),
    /session storage/,
  );
  await assert.rejects(access(join(sessionDir, "blocked")));
  await assert.rejects(
    f.call("write_file", { path: "missing/overwrite.txt", content: "bad", expectedContent: "old" }),
  );
  await assert.rejects(access(join(f.cwd, "missing")));
  const limited = await createWorkspaceTools(f.cwd, policy(), { limits: { maxFileBytes: 1 } });
  await assert.rejects(
    limited
      .find((tool) => tool.name === "write_file")
      .execute({ path: "too-large/new/file", content: "xx" }, {}, {}),
    /limit/,
  );
  await assert.rejects(access(join(f.cwd, "too-large")));
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    f.call("write_file", { path: "cancelled/new/file", content: "x" }, cancelled.signal),
    /cancelled/,
  );
  await assert.rejects(access(join(f.cwd, "cancelled")));
});

test("commands use only fixed argv without shell expansion or inherited provider secrets", async () => {
  const previous = process.env.YORISHIRO_TOOLS_TEST_SECRET;
  process.env.YORISHIRO_TOOLS_TEST_SECRET = "must not reach command";
  try {
    const f = await fixture({
      commands: [
        {
          id: "fixed",
          program: process.execPath,
          args: [
            "-e",
            "process.stdout.write(JSON.stringify({args:process.argv.slice(1),secret:process.env.YORISHIRO_TOOLS_TEST_SECRET??null,cwd:process.cwd()}))",
            "$(touch unwanted); literal",
          ],
        },
      ],
    });
    const result = await f.call("run_command", { commandId: "fixed" });
    const observed = JSON.parse(result.output[0].text);
    assert.deepEqual(observed.args, ["$(touch unwanted); literal"]);
    assert.equal(observed.secret, null);
    assert.equal(observed.cwd, await realpath(f.cwd));
    await assert.rejects(f.call("run_command", { commandId: "not-allowed" }), /not permitted/);
    await assert.rejects(access(join(f.cwd, "unwanted")));
  } finally {
    if (previous === undefined) delete process.env.YORISHIRO_TOOLS_TEST_SECRET;
    else process.env.YORISHIRO_TOOLS_TEST_SECRET = previous;
  }
});

test("command output and runtime are bounded; cancellation terminates its owned process", {
  timeout: 8000,
}, async () => {
  const f = await fixture(
    {
      commands: [
        {
          id: "noisy",
          program: process.execPath,
          args: ["-e", "process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000)"],
        },
        { id: "wait", program: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] },
      ],
    },
    { limits: { maxCommandOutputBytes: 32, commandTimeoutMs: 300, commandKillGraceMs: 100 } },
  );
  await assert.rejects(f.call("run_command", { commandId: "noisy" }), /output limit/);
  await assert.rejects(f.call("run_command", { commandId: "wait" }), /deadline/);
  const controller = new AbortController();
  const waiting = f.call("run_command", { commandId: "wait" }, controller.signal);
  setTimeout(() => controller.abort(), 60);
  await assert.rejects(waiting, /cancelled/);
});

test("only configured command deadlines extend real child execution and cancellation still wins", {
  timeout: 8000,
}, async () => {
  const args = [
    "-e",
    "setTimeout(()=>{require('node:fs').writeFileSync('completed.txt','done');console.log('completed')},350)",
  ];
  const f = await fixture(
    {
      commands: [
        { id: "default", program: process.execPath, args },
        { id: "longer", program: process.execPath, args, timeoutMs: 2000 },
        {
          id: "cancel",
          program: process.execPath,
          args: [
            "-e",
            "setTimeout(()=>require('node:fs').writeFileSync('cancelled.txt','bad'),500)",
          ],
          timeoutMs: 2000,
        },
      ],
    },
    { limits: { commandTimeoutMs: 100, commandKillGraceMs: 100 } },
  );
  const schema = f.tools.find((tool) => tool.name === "run_command").parameters;
  assert.deepEqual(Object.keys(schema.properties), ["commandId"]);
  assert.equal(schema.additionalProperties, false);
  // Direct calls also cannot turn an unconfigured model argument into a host override.
  await assert.rejects(
    f.call("run_command", { commandId: "default", timeoutMs: 5000 }),
    /deadline/,
  );
  await assert.rejects(access(join(f.cwd, "completed.txt")));
  const result = await f.call("run_command", { commandId: "longer" });
  assert.equal(result.output[0].text, "completed\n");
  assert.equal(await readFile(join(f.cwd, "completed.txt"), "utf8"), "done");
  const controller = new AbortController();
  const waiting = f.call("run_command", { commandId: "cancel" }, controller.signal);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(waiting, /cancelled/);
  await assert.rejects(access(join(f.cwd, "cancelled.txt")));
});

test("Unix command cleanup stops its descendants without stopping an unrelated child", {
  timeout: 8000,
}, async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix owned process-group cleanup");
    return;
  }
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  t.after(async () => {
    if (unrelated.exitCode === null && unrelated.signalCode === null) {
      const closed = once(unrelated, "close");
      unrelated.kill("SIGKILL");
      await closed;
    }
  });
  const childCode =
    "const fs=require('node:fs');fs.appendFileSync('heartbeat.txt','x');setInterval(()=>fs.appendFileSync('heartbeat.txt','x'),20)";
  const parentCode = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit'});setInterval(()=>{},1000)`;
  const f = await fixture(
    { commands: [{ id: "descendants", program: process.execPath, args: ["-e", parentCode] }] },
    { limits: { commandTimeoutMs: 500, commandKillGraceMs: 100 } },
  );
  await assert.rejects(f.call("run_command", { commandId: "descendants" }), /deadline/);
  const stopped = await readFile(join(f.cwd, "heartbeat.txt"), "utf8");
  assert.ok(stopped.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await readFile(join(f.cwd, "heartbeat.txt"), "utf8"), stopped);
  assert.equal(unrelated.exitCode, null);
  assert.equal(unrelated.signalCode, null);
});

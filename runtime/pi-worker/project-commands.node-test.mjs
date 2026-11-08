import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  COMMAND_PRESET_IDS,
  PROJECT_COMMAND_IDS,
  PROJECT_TIMEOUT_MS,
  projectCapabilities,
  verifiedProjectCommandIds,
} from "./project-commands.mjs";
import { inspectWorkspace } from "./workspace-check.mjs";
import { createWorkspaceTools } from "./workspace-tools.mjs";

const helper = fileURLToPath(new URL("./workspace-check.mjs", import.meta.url));
const grant = (id) => ({
  id,
  program: process.execPath,
  args: [helper, id],
  ...(PROJECT_COMMAND_IDS.includes(id) ? { timeoutMs: PROJECT_TIMEOUT_MS } : {}),
});
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "yorishiro-project-commands-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function runner(root, ids, options) {
  const tools = await createWorkspaceTools(
    root,
    { read: true, write: false, commands: ids.map(grant) },
    options,
  );
  return (id, signal) =>
    tools
      .find(({ name }) => name === "run_command")
      .execute({ commandId: id }, {}, { abortSignal: signal });
}
async function packageFixture(root, scripts) {
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "local-fixture", version: "1.0.0", private: true, scripts }),
  );
}
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("fixture condition did not become true");
}

test("all development grants are fixed opt-ins and spoofed legacy command IDs are not trusted evidence", async (t) => {
  const root = await fixture(t);
  const commands = PROJECT_COMMAND_IDS.map(grant);
  assert.deepEqual([...(await verifiedProjectCommandIds({ commands }))], PROJECT_COMMAND_IDS);
  const fake = join(root, "fake-node");
  await writeFile(fake, "not the bundled node");
  for (const mutation of [
    { program: fake },
    { args: [helper, "project-check", "--extra"] },
    { args: [helper, "project-build"] },
    { timeoutMs: 30_000 },
    { args: [fake, "project-check"] },
  ])
    assert.equal(
      (await verifiedProjectCommandIds({ commands: [{ ...grant("project-check"), ...mutation }] }))
        .size,
      0,
    );
  assert.equal((await verifiedProjectCommandIds({ commands: [grant("git-status")] })).size, 0);
});

test("npm checks, tests and builds execute the selected declared scripts using own Node and clean CI environment", async (t) => {
  const root = await fixture(t);
  await packageFixture(root, {
    check: "node capture.mjs check",
    lint: "node capture.mjs wrong",
    "test:run": "node capture.mjs test",
    test: "node capture.mjs watch",
    build: "node capture.mjs build",
  });
  await writeFile(
    join(root, "capture.mjs"),
    `import{writeFileSync}from'node:fs';writeFileSync(process.argv[2]+'.json',JSON.stringify({cwd:process.cwd(),node:process.execPath,ci:process.env.CI,incremental:process.env.CARGO_INCREMENTAL,target:process.env.CARGO_TARGET_DIR,secret:process.env.OPENAI_API_KEY,other:process.env.ANTHROPIC_API_KEY}));`,
  );
  const oldOpenai = process.env.OPENAI_API_KEY;
  const oldOther = process.env.ANTHROPIC_API_KEY;
  const oldTarget = process.env.CARGO_TARGET_DIR;
  process.env.CARGO_TARGET_DIR = join(root, "explicit-user-target");
  process.env.OPENAI_API_KEY = "PRIVATE_OPENAI";
  process.env.ANTHROPIC_API_KEY = "PRIVATE_ANTHROPIC";
  t.after(() => {
    if (oldOpenai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldOpenai;
    if (oldOther === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = oldOther;
    if (oldTarget === undefined) delete process.env.CARGO_TARGET_DIR;
    else process.env.CARGO_TARGET_DIR = oldTarget;
  });
  const run = await runner(root, PROJECT_COMMAND_IDS);
  for (const step of ["check", "test", "build"]) {
    await run(`project-${step}`);
    const result = JSON.parse(await readFile(join(root, `${step}.json`), "utf8"));
    assert.equal(result.cwd, root);
    assert.equal(await realpath(result.node), await realpath(process.execPath));
    assert.equal(result.ci, "true");
    assert.equal(result.incremental, "0");
    assert.equal(result.target, join(root, "explicit-user-target"));
    assert.equal(result.secret, undefined);
    assert.equal(result.other, undefined);
  }
  await assert.rejects(readFile(join(root, "wrong.json")), { code: "ENOENT" });
  await assert.rejects(readFile(join(root, "watch.json")), { code: "ENOENT" });
  const legacy = await createWorkspaceTools(root, {
    read: true,
    write: false,
    commands: [
      {
        id: "project-check",
        program: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify({target:process.env.CARGO_TARGET_DIR}))"],
        timeoutMs: PROJECT_TIMEOUT_MS,
      },
    ],
  });
  const result = await legacy[1].execute({ commandId: "project-check" }, {}, {});
  assert.deepEqual(JSON.parse(result.output[0].text), {});
});

test("project detection uses fixed fallbacks, avoids watchers, and never searches parent projects", async (t) => {
  const root = await fixture(t);
  await packageFixture(root, {
    typecheck: "node capture.mjs check",
    test: "node capture.mjs vitest",
    build: "node capture.mjs build",
  });
  await writeFile(
    join(root, "capture.mjs"),
    `import{writeFileSync}from'node:fs';writeFileSync('args.json',JSON.stringify(process.argv.slice(2)));`,
  );
  const capabilities = await projectCapabilities(root);
  assert.equal(capabilities.scripts.check, "typecheck");
  const run = await runner(root, ["project-test"]);
  await run("project-test");
  assert.deepEqual(JSON.parse(await readFile(join(root, "args.json"), "utf8")), [
    "vitest",
    "--run",
  ]);
  const child = join(root, "child");
  await mkdir(child);
  assert.deepEqual(await projectCapabilities(child), { kind: "none", availableCommands: [] });
});

test("Cargo projects receive only fixed check/test/build argv and npm projects take precedence", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "Cargo.toml"), '[package]\nname="fixture"\nversion="0.1.0"\n');
  assert.deepEqual((await projectCapabilities(root)).availableCommands, PROJECT_COMMAND_IDS);
  const bin = join(root, "bin");
  await mkdir(bin);
  const cargo = join(bin, "cargo");
  await writeFile(
    cargo,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync('cargo-'+process.argv[2]+'.json',JSON.stringify({args:process.argv.slice(2),ci:process.env.CI,secret:process.env.OPENAI_API_KEY}));\n`,
  );
  await chmod(cargo, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    const run = await runner(root, PROJECT_COMMAND_IDS);
    for (const action of ["check", "test", "build"]) {
      await run(`project-${action}`);
      assert.deepEqual(JSON.parse(await readFile(join(root, `cargo-${action}.json`), "utf8")), {
        args: [action],
        ci: "true",
      });
    }
  } finally {
    process.env.PATH = oldPath;
  }
  await packageFixture(root, { check: "node -e '0'" });
  assert.equal((await projectCapabilities(root)).kind, "npm");
});

test("missing script/tool and a failed real project command return actionable failures", async (t) => {
  const root = await fixture(t);
  await packageFixture(root, { check: "node -e 'process.exit(7)'" });
  const run = await runner(root, PROJECT_COMMAND_IDS);
  await assert.rejects(run("project-build"), /No project-build script.*selected folder/);
  await assert.rejects(run("project-check"), /Project command failed \(7\)/);
  const result = spawnSync(process.execPath, [helper, "project-check"], {
    cwd: root,
    env: { PATH: "" },
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /npm is unavailable.*Install npm/);
  await writeFile(join(root, "package.json"), "PRIVATE_INVALID_MANIFEST");
  await assert.rejects(
    run("project-check"),
    (error) =>
      /Cannot read package.json/.test(error.message) &&
      !error.message.includes("PRIVATE_INVALID_MANIFEST"),
  );
});

test("real npm command cancellation and output bounds stop its owned descendants", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await fixture(t);
  await packageFixture(root, {
    check: "node wait.mjs",
    build: "node -e 'process.stdout.write(\"x\".repeat(10000));setInterval(()=>{},1000)'",
  });
  await writeFile(
    join(root, "wait.mjs"),
    `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync('child.pid',String(child.pid));setInterval(()=>{},1000);`,
  );
  const run = await runner(root, ["project-check", "project-build"], {
    limits: { maxCommandOutputBytes: 1024 },
  });
  const abort = new AbortController();
  const running = run("project-check", abort.signal);
  const settled = running.catch((error) => error);
  await until(async () =>
    readFile(join(root, "child.pid")).then(
      () => true,
      () => false,
    ),
  );
  const pid = Number(await readFile(join(root, "child.pid"), "utf8"));
  abort.abort();
  assert.match((await settled).message, /cancelled/);
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  });
  await assert.rejects(run("project-build"), /output limit/);
});

test("workspace information identifies primary, current linked branch and spoofed registrations without requiring worktrees", async (t) => {
  const root = await fixture(t);
  const primary = join(root, "primary");
  const linked = join(root, "linked");
  const git = (args, cwd = root) =>
    execFileSync("git", args, {
      cwd,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(root, "no-global-config"),
      },
      stdio: "pipe",
    });
  git(["init", "-b", "main", primary]);
  await writeFile(join(primary, "file.txt"), "original\n");
  git(["add", "."], primary);
  git(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "initial",
    ],
    primary,
  );
  git(["worktree", "add", "-b", "already-selected-worktree", linked], primary);
  const mainInfo = await inspectWorkspace("workspace-info", primary);
  assert.equal(mainInfo.repository.kind, "primary");
  assert.equal(mainInfo.repository.linkedWorktreeVerified, false);
  const run = await runner(linked, ["workspace-info", "git-status"]);
  const info = JSON.parse((await run("workspace-info")).output[0].text);
  assert.equal(info.cwd, linked);
  assert.equal(info.repository.kind, "linked");
  assert.equal(info.repository.branch, "already-selected-worktree");
  assert.equal(info.repository.linkedWorktreeVerified, true);
  assert.deepEqual(info.grantedCommandPresets, ["workspace-info", "git-status"]);
  assert.deepEqual(info.fileCapabilities, { read: true, write: false });
  assert.deepEqual(info.supportedCommandPresets, COMMAND_PRESET_IDS);
  assert.match(info.note, /Worktrees are optional/);
  const spoof = join(root, "spoof");
  await mkdir(spoof);
  await writeFile(join(spoof, ".git"), await readFile(join(linked, ".git")));
  assert.equal(
    (await inspectWorkspace("workspace-info", spoof)).repository.linkedWorktreeVerified,
    false,
  );
  await symlink(join(linked, ".git"), join(root, ".git"));
  assert.equal((await inspectWorkspace("workspace-info", root)).repository.kind, "unverified");
});

test("read-only Git presets report staged and unstaged changes without running external diff, textconv or fsmonitor", async (t) => {
  const root = await fixture(t);
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      stdio: "pipe",
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(root, "no-global-config"),
      },
    });
  git(["init", "-b", "main"]);
  await writeFile(join(root, "task.txt"), "initial\n");
  git(["add", "."]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "initial",
  ]);
  await writeFile(join(root, "task.txt"), "staged\n");
  git(["add", "task.txt"]);
  await writeFile(join(root, "task.txt"), "unstaged\n");
  const danger = join(root, "unsafe-hook");
  await writeFile(
    danger,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync('HOOK_EXECUTED','unsafe');`,
  );
  await chmod(danger, 0o755);
  git(["config", "core.fsmonitor", danger]);
  git(["config", "diff.external", danger]);
  git(["config", "diff.fixture.textconv", danger]);
  await writeFile(join(root, ".gitattributes"), "*.txt diff=fixture\n");
  const head = git(["rev-parse", "HEAD"]).toString();
  const run = await runner(root, ["git-status", "git-diff"]);
  assert.match((await run("git-status")).output[0].text, /task\.txt/);
  const diff = (await run("git-diff")).output[0].text;
  assert.match(diff, /Unstaged changes:/);
  assert.match(diff, /Staged changes:/);
  assert.match(diff, /\+staged/);
  assert.match(diff, /\+unstaged/);
  await assert.rejects(readFile(join(root, "HOOK_EXECUTED")), { code: "ENOENT" });
  assert.equal(git(["rev-parse", "HEAD"]).toString(), head);
  assert.equal(await readFile(join(root, "task.txt"), "utf8"), "unstaged\n");
});

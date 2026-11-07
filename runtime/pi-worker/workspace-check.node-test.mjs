import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inspectWorkspace } from "./workspace-check.mjs";

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "pi-workspace-check-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("portable checks use the selected folder and expose no absolute paths or contents", async () =>
  fixture(async (root) => {
    await writeFile(join(root, "result.json"), '{"private":"DO_NOT_ECHO"}');
    await mkdir(join(root, "folder"));
    const result = await inspectWorkspace("workspace-info", root);
    assert.deepEqual(result.items, [
      { name: "folder", kind: "directory" },
      { name: "result.json", kind: "file" },
    ]);
    assert.equal(JSON.stringify(result).includes(root), false);
    const checked = await inspectWorkspace("validate-json", root);
    assert.equal(checked.complete, true);
    assert.equal(checked.invalidFiles, 0);
    assert.equal(JSON.stringify(checked).includes("DO_NOT_ECHO"), false);
    assert.equal(await readFile(join(root, "result.json"), "utf8"), '{"private":"DO_NOT_ECHO"}');
  }));

test("JSON validation reports syntax failure without parse text or private data", async () =>
  fixture(async (root) => {
    await writeFile(join(root, "invalid.json"), "PRIVATE_CONTENT_INVALID");
    const result = await inspectWorkspace("validate-json", root);
    assert.equal(result.invalidFiles, 1);
    assert.equal(JSON.stringify(result).includes("PRIVATE_CONTENT_INVALID"), false);
  }));

test("checks exclude credential/state/dependency folders and symlink escapes", async () =>
  fixture(async (root) => {
    for (const folder of [".yorishiro", ".git", "node_modules"]) {
      await mkdir(join(root, folder));
      await writeFile(join(root, folder, "invalid.json"), "private invalid");
    }
    await symlink(tmpdir(), join(root, "outside"));
    const result = await inspectWorkspace("validate-json", root);
    assert.equal(result.files.length, 0);
    assert.equal(result.excludedSymlinks, 1);
  }));

test("oversized files and excessive listing are explicitly incomplete", async () =>
  fixture(async (root) => {
    await writeFile(join(root, "large.json"), "x".repeat(1024 * 1024 + 1));
    const result = await inspectWorkspace("validate-json", root);
    assert.equal(result.complete, false);
    assert.equal(result.files.length, 0);
    for (let index = 0; index < 65; index++) await writeFile(join(root, `file-${index}`), "");
    assert.equal((await inspectWorkspace("workspace-info", root)).complete, false);
  }));

test("unknown commands cannot become arbitrary executable arguments", async () => {
  await assert.rejects(inspectWorkspace("/bin/sh"), /workspace_check_invalid/);
});

test("CLI remains executable through relocated or symlinked paths with no system PATH", async () =>
  fixture(async (root) => {
    await writeFile(join(root, "result.json"), '{"ok":true}');
    const executable = join(root, "relocated check.mjs");
    await symlink(fileURLToPath(new URL("./workspace-check.mjs", import.meta.url)), executable);
    const result = spawnSync(process.execPath, [executable, "validate-json"], {
      cwd: root,
      env: { PATH: "", HOME: root },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.check, "validate-json");
    assert.deepEqual(report.files, [{ name: "result.json", valid: true }]);
  }));

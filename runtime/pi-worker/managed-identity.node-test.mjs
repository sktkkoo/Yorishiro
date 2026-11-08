import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateManagedIdentity } from "./managed-identity.mjs";
import {
  COMMAND_PRESET_IDS,
  PROJECT_COMMAND_IDS,
  PROJECT_TIMEOUT_MS,
} from "./project-commands.mjs";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-managed-identity-")));
  const home = join(root, "User Data");
  const cwd = join(root, "User Project");
  mkdirSync(home);
  mkdirSync(cwd);
  const stateKey = "b".repeat(64);
  const sessionDir = join(home, "continuity/pi", stateKey, "generations/2");
  mkdirSync(sessionDir, { recursive: true });
  const authPath = join(home, "continuity/pi/auth.json");
  writeFileSync(authPath, "{}", { mode: 0o600 });
  const node = join(root, "First App", "node");
  const checker = join(root, "First App", "workspace-check.mjs");
  mkdirSync(join(root, "First App"));
  writeFileSync(node, "");
  writeFileSync(checker, "");
  const permissions = { read: true, write: false, commands: ["validate-json"] };
  const value = {
    version: 2,
    runtime: "bundled",
    runtimeVersion: "pi-1.5.0/node-22.23.4",
    workspaceKey: createHash("sha256").update(cwd).digest("hex"),
    familyKey: "c".repeat(64),
    stateKey,
    generation: 2,
    provider: "openai",
    model: "gpt-6.1-sol",
    authMode: "oauth",
    permissions,
  };
  const options = {
    cwd,
    sessionDir,
    authPath,
    provider: value.provider,
    model: value.model,
    authMode: "oauth",
    permissions: {
      read: true,
      write: false,
      commands: [{ id: "validate-json", program: node, args: [checker, "validate-json"] }],
    },
  };
  return { root, home, cwd, node, checker, value, options };
}

test("managed installation identity is path free and survives a moved application", () => {
  const f = fixture();
  try {
    const identity = validateManagedIdentity(f.value, f.options, f);
    assert.equal(JSON.stringify(identity).includes(f.root), false);
    const moved = join(f.root, "Moved App With Spaces");
    mkdirSync(moved);
    const node = join(moved, "node"),
      checker = join(moved, "workspace-check.mjs");
    writeFileSync(node, "");
    writeFileSync(checker, "");
    const options = {
      ...f.options,
      permissions: {
        ...f.options.permissions,
        commands: [{ id: "validate-json", program: node, args: [checker, "validate-json"] }],
      },
    };
    assert.deepEqual(
      validateManagedIdentity(identity, options, { home: f.home, node, checker }),
      identity,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("managed identity rejects expanded permissions, changed workspace and arbitrary executable", () => {
  const f = fixture();
  try {
    assert.throws(
      () => validateManagedIdentity({ ...f.value, nodePath: "/untrusted/node" }, f.options, f),
      /managed_identity_invalid/,
    );
    assert.throws(
      () => validateManagedIdentity({ ...f.value, workspaceKey: "0".repeat(64) }, f.options, f),
      /managed_identity_invalid/,
    );
    assert.throws(
      () =>
        validateManagedIdentity(
          { ...f.value, permissions: { ...f.value.permissions, write: true } },
          f.options,
          f,
        ),
      /managed_identity_invalid/,
    );
    assert.throws(
      () =>
        validateManagedIdentity(
          { ...f.value, permissions: { ...f.value.permissions, commands: ["shell"] } },
          f.options,
          f,
        ),
      /managed_identity_invalid/,
    );
    assert.equal(validateManagedIdentity(undefined, f.options), undefined);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("development grants require exact bundled helper argv and project-only bounded timeouts", () => {
  const f = fixture();
  try {
    const identity = {
      ...f.value,
      permissions: { ...f.value.permissions, commands: [...COMMAND_PRESET_IDS] },
    };
    const options = {
      ...f.options,
      permissions: {
        ...f.options.permissions,
        commands: COMMAND_PRESET_IDS.map((id) => ({
          id,
          program: f.node,
          args: [f.checker, id],
          ...(PROJECT_COMMAND_IDS.includes(id) ? { timeoutMs: PROJECT_TIMEOUT_MS } : {}),
        })),
      },
    };
    assert.deepEqual(validateManagedIdentity(identity, options, f), identity);
    for (const index of [0, 4]) {
      const changed = structuredClone(options);
      changed.permissions.commands[index].timeoutMs = 30_000;
      assert.throws(
        () => validateManagedIdentity(identity, changed, f),
        /managed_identity_invalid/,
      );
    }
    const extra = structuredClone(options);
    extra.permissions.commands[4].args.push("model-provided-argument");
    assert.throws(() => validateManagedIdentity(identity, extra, f), /managed_identity_invalid/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("managed file grants cannot modify native preferences or authoritative history", async () => {
  const f = fixture();
  try {
    const { protectedInstallationPaths } = await import("./managed-identity.mjs");
    const { createWorkspaceTools } = await import("./workspace-tools.mjs");
    const prefs = join(f.home, "continuity/pi-worker.json");
    const state = join(f.home, "continuity/builtin/yori/state.json");
    mkdirSync(join(f.home, "continuity/builtin/yori"), { recursive: true });
    writeFileSync(prefs, "{}");
    writeFileSync(state, "{}");
    const protectedPaths = protectedInstallationPaths({ ...f.options, managedIdentity: f.value });
    const tools = await createWorkspaceTools(
      f.root,
      { read: true, write: true, commands: [] },
      { protectedPaths },
    );
    const call = (name, args) => tools.find((tool) => tool.name === name).execute(args, {}, {});
    for (const path of [
      "User Data/continuity/pi-worker.json",
      "User Data/continuity/builtin/yori/state.json",
    ]) {
      await assert.rejects(
        call("write_file", { path, content: '{"write":true}', expectedContent: "{}" }),
        /storage|protected/i,
      );
      await assert.rejects(call("read_file", { path }), /storage|protected/i);
    }
    await call("write_file", { path: "project-result.md", content: "Authorized result" });
    assert.equal(
      (await call("read_file", { path: "project-result.md" })).output[0].text,
      "Authorized result",
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

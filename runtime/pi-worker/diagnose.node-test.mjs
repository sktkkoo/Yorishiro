import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { diagnose, supportsNode } from "./diagnose.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "pi-worker-diagnose-"));
const policy = JSON.stringify({ read: true, write: false, commands: [] });
const names = ["node", "configuration", "dependencies", "model", "authentication"];
const guard = join(scratch, "offline-guard.mjs");
writeFileSync(
  guard,
  `import { syncBuiltinESMExports } from "node:module";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import child from "node:child_process";
const forbidden = () => process.exit(91);
globalThis.fetch = forbidden;
http.request = http.get = https.request = https.get = forbidden;
net.Socket.prototype.connect = forbidden;
child.spawn = child.spawnSync = child.exec = child.execFile = child.fork = forbidden;
syncBuiltinESMExports();
`,
);

function args(extra = {}) {
  return Object.entries({
    "session-dir": join(scratch, "not-created"),
    cwd: scratch,
    provider: "openai",
    model: openaiProvider().getModels()[0].id,
    "permissions-json": policy,
    ...extra,
  }).flatMap(([key, value]) => [`--${key}`, value]);
}

function childReport(command, environment = {}, entry = join(here, "diagnose.mjs")) {
  const child = spawnSync(process.execPath, ["--import", guard, entry, ...command], {
    env: environment,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim().split("\n").length, 1);
  const report = JSON.parse(child.stdout);
  assert.deepEqual(Object.keys(report), ["protocol", "ready", "checks"]);
  assert.equal(report.protocol, 1);
  assert.deepEqual(
    report.checks.map((entry) => entry.name),
    names,
  );
  assert.equal(
    report.ready,
    report.checks.every((entry) => entry.status === "ok"),
  );
  for (const entry of report.checks) {
    assert.deepEqual(Object.keys(entry), ["name", "status", "code"]);
    assert.ok(["ok", "missing", "invalid", "blocked"].includes(entry.status));
  }
  assert.doesNotMatch(
    child.stdout + child.stderr,
    /sentinel-secret|not-a-real-model|fixture-policy/,
  );
  return Object.fromEntries(report.checks.map((entry) => [entry.name, entry]));
}

test("Node compatibility is checked before any production dependency import", async () => {
  for (const version of ["20.19.0", "22.18.9", "22.19.0-rc.1", "invalid"]) {
    const result = await diagnose([], {
      nodeVersion: version,
      load: () => assert.fail("unsupported Node must not import dependencies"),
    });
    assert.equal(result.ready, false);
    assert.equal(result.checks[0].code, "node_unsupported");
    assert.ok(result.checks.slice(1).every((entry) => entry.status === "blocked"));
  }
  for (const version of ["22.19.0", "22.23.4", "23.0.0", "24.0.0"]) {
    assert.equal(supportsNode(version), true);
  }
  const report = await diagnose([], {
    load: () => {
      throw new Error("sentinel-secret");
    },
  });
  assert.equal(report.checks[2].code, "dependencies_invalid");
  assert.doesNotMatch(JSON.stringify(report), /sentinel-secret/);
});

test("empty-env diagnosis reports missing auth independently and leaves storage untouched", () => {
  const existing = join(scratch, "existing-session");
  mkdirSync(existing);
  writeFileSync(join(existing, "sentinel.bin"), Buffer.from([0, 17, 255, 4]));
  const snapshot = readFileSync(join(existing, "sentinel.bin"));
  for (const sessionDir of [existing, join(scratch, "not-created")]) {
    const checks = childReport(args({ "session-dir": sessionDir }));
    assert.equal(checks.configuration.code, "configuration_valid");
    assert.equal(checks.dependencies.code, "dependencies_available");
    assert.equal(checks.model.code, "model_available");
    assert.equal(checks.authentication.code, "authentication_missing");
  }
  assert.deepEqual(readdirSync(existing), ["sentinel.bin"]);
  assert.deepEqual(readFileSync(join(existing, "sentinel.bin")), snapshot);
  assert.equal(existsSync(join(scratch, "not-created")), false);
});

test("invalid offline model and absent auth are reported individually in an empty env", () => {
  const checks = childReport(args({ model: "not-a-real-model" }));
  assert.equal(checks.model.status, "missing");
  assert.equal(checks.model.code, "model_unavailable");
  assert.equal(checks.authentication.code, "authentication_missing");
});

test("ready means offline presence only; both providers avoid all network and worker execution", () => {
  for (const [provider, factory, keyName] of [
    ["openai", openaiProvider, "OPENAI_API_KEY"],
    ["anthropic", anthropicProvider, "ANTHROPIC_API_KEY"],
  ]) {
    const command = args({ provider, model: factory().getModels()[0].id });
    const checks = childReport(command, { [keyName]: "sentinel-secret" });
    assert.ok(Object.values(checks).every((entry) => entry.status === "ok"));
    const blank = childReport(command, { [keyName]: " \t\n" });
    assert.equal(blank.authentication.code, "authentication_missing");
  }
  assert.equal(existsSync(join(scratch, "not-created")), false);
});

test("invalid flags, workspace, permissions and provider receive one fixed configuration code", () => {
  for (const command of [
    [],
    [...args(), "--fixture", "fixture-policy"],
    args({ cwd: "relative" }),
    args({ provider: "faux" }),
    args({ "permissions-json": "{}" }),
  ]) {
    const checks = childReport(command);
    assert.equal(checks.configuration.status, "invalid");
    assert.equal(checks.configuration.code, "configuration_invalid");
    assert.equal(checks.model.status, "blocked");
    assert.equal(checks.authentication.status, "blocked");
  }
});

test("a real empty-env child without installed dependencies returns missing rather than throwing", () => {
  const isolated = join(scratch, "without-dependencies");
  mkdirSync(isolated);
  for (const file of ["diagnose.mjs", "config.mjs", "workspace-tools.mjs"]) {
    copyFileSync(join(here, file), join(isolated, file));
  }
  const checks = childReport(args(), {}, join(isolated, "diagnose.mjs"));
  assert.equal(checks.dependencies.status, "missing");
  assert.equal(checks.dependencies.code, "dependencies_missing");
  for (const name of ["configuration", "model", "authentication"]) {
    assert.equal(checks[name].status, "blocked");
  }
  assert.equal(existsSync(join(scratch, "not-created")), false);
});

test("OAuth readiness reads private metadata only, never creates auth state or uses API-key fallback", () => {
  const directory = join(scratch, "oauth-private");
  const path = join(directory, "auth.json");
  const command = args({ "auth-mode": "oauth", "auth-path": path });
  let checks = childReport(command, { OPENAI_API_KEY: "sentinel-secret" });
  assert.equal(checks.authentication.code, "authentication_missing");
  assert.equal(existsSync(directory), false);
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(
    path,
    JSON.stringify({
      openai: { type: "oauth", access: "sentinel-secret", refresh: "sentinel-secret", expires: 0 },
    }),
    { mode: 0o600 },
  );
  const before = readFileSync(path);
  checks = childReport(command);
  assert.equal(checks.authentication.code, "authentication_present");
  assert.deepEqual(readdirSync(directory), ["auth.json"]);
  assert.deepEqual(readFileSync(path), before);
  writeFileSync(path, "{sentinel-secret");
  checks = childReport(command);
  assert.equal(checks.authentication.code, "authentication_invalid");
  writeFileSync(path, JSON.stringify({ openai: { type: "api_key", key: "sentinel-secret" } }));
  checks = childReport(command);
  assert.equal(checks.authentication.code, "authentication_invalid");
});

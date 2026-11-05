import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createConfiguredModels, parseOptions } from "./config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "pi-worker-startup-"));
const permissions = { read: true, write: false, commands: [] };
const args = (extra = {}) => {
  const options = {
    "session-dir": join(scratch, "unopened"),
    cwd: scratch,
    provider: "openai",
    model: openaiProvider().getModels()[0].id,
    "permissions-json": JSON.stringify(permissions),
    ...extra,
  };
  return Object.entries(options).flatMap(([name, value]) => [`--${name}`, value]);
};

test("production options require explicit model, workspace, permissions and reject fixture mode", () => {
  assert.throws(() => parseOptions([]), /configuration_invalid/);
  assert.throws(() => parseOptions(["--fixture", scratch]), /configuration_invalid/);
  assert.throws(() => parseOptions(args({ cwd: "relative" })), /configuration_invalid/);
  assert.throws(() => parseOptions(args({ "permissions-json": "{}" })), /permissions_invalid/);
  assert.throws(() => parseOptions(args({ provider: "faux" })), /provider_unconfigured/);
  assert.throws(() => parseOptions([...args(), "--model", "duplicate"]), /configuration_invalid/);
  assert.deepEqual(parseOptions(args()).permissions, permissions);
});

test("direct provider validation is offline, explicit and never substitutes a model", () => {
  for (const [provider, factory, key] of [
    ["openai", openaiProvider, "OPENAI_API_KEY"],
    ["anthropic", anthropicProvider, "ANTHROPIC_API_KEY"],
  ]) {
    const options = { provider, model: factory().getModels()[0].id };
    assert.throws(() => createConfiguredModels(options, {}), /provider_unconfigured/);
    const models = createConfiguredModels(options, { [key]: "offline-test-placeholder" });
    assert.equal(models.getModel(provider, options.model).id, options.model);
    assert.equal(models.getProviders().length, 1);
    assert.throws(
      () =>
        createConfiguredModels(
          { ...options, model: "not-a-real-model" },
          { [key]: "offline-test-placeholder" },
        ),
      /model_unavailable/,
    );
  }
});

test("unconfigured production child emits fixed errors before storage or network execution", () => {
  for (const command of [[], ["--fixture", scratch], args(), args({ model: "not-a-model" })]) {
    const child = spawnSync(process.execPath, [join(here, "main.mjs"), ...command], {
      env: {},
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(child.status, 2, child.stderr);
    const records = child.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].type, "startup_error");
    assert.ok(["configuration_invalid", "provider_unconfigured"].includes(records[0].code));
    assert.equal(existsSync(join(scratch, "unopened")), false);
    assert.doesNotMatch(child.stdout + child.stderr, /offline-test-placeholder/);
  }
});

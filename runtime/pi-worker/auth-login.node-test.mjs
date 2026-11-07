import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { authStatus, loginWithPi, officialAuthUrl } from "./auth-login.mjs";

const url =
  "https://auth.openai.com/api/accounts/authorize?state=TRANSIENT&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback";
const device = "12345678-1234-1234-1234-123456789abc";
const provider = () => ({ getModels: () => [{ id: "fixture-model", name: "Fixture" }] });

test("OAuth URLs are confined to the official authorization endpoint", () => {
  assert.equal(officialAuthUrl(url), true);
  assert.equal(
    officialAuthUrl(
      url.replace(
        "http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback",
        "https%3A%2F%2Fattacker.invalid%2Fcallback",
      ),
    ),
    false,
  );
  assert.equal(
    officialAuthUrl(`${url}&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback`),
    false,
  );
  for (const value of [
    "http://auth.openai.com/api/accounts/authorize",
    "https://auth.openai.com.evil.invalid/api/accounts/authorize",
    "https://secret@auth.openai.com/api/accounts/authorize",
    "https://auth.openai.com:444/api/accounts/authorize",
    "https://auth.openai.com/log-in",
    "https://auth.openai.com/api/accounts/authorize#secret",
    "file:///private/auth.json",
  ])
    assert.equal(officialAuthUrl(value), false);
});

test("status is metadata only and never creates a first-user credential directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-auth-status-"));
  try {
    const path = join(directory, "new-user", "auth.json");
    const result = authStatus(path, { provider });
    assert.equal(result.authenticated, false);
    assert.equal(result.authentication, "missing");
    assert.equal(existsSync(join(directory, "new-user")), false);
    assert.deepEqual(result.models, [{ id: "fixture-model", name: "Fixture" }]);
    const invalid = authStatus(path, {
      provider,
      metadata: () => ({ present: true, type: "api_key", token: "PRIVATE" }),
    });
    assert.equal(invalid.authenticated, false);
    assert.equal(invalid.authentication, "invalid");
    assert.equal(JSON.stringify(invalid).includes("PRIVATE"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("browser login uses the production store and preloads a synchronous stable installation ID", async () => {
  const events = [];
  let closed = false;
  let checkedModels = false;
  const store = {
    deviceId: async () => device,
    close: async () => {
      closed = true;
    },
  };
  const result = await loginWithPi(
    {
      authPath: "fixture",
      signal: new AbortController().signal,
      emit: (value) => events.push(value),
    },
    {
      store: () => store,
      provider,
      models: (options) => {
        assert.equal(options.credentials, store);
        checkedModels = true;
        return {
          setProvider() {},
          async login(id, type, interaction, identity) {
            assert.equal(id, "openai");
            assert.equal(type, "oauth");
            assert.equal(identity.getDeviceId(), device);
            assert.equal(typeof identity.getDeviceId(), "string");
            assert.equal(identity.agentName, "Yorishiro");
            assert.equal(await options.authContext.env("OPENAI_API_KEY"), undefined);
            assert.equal(await options.authContext.fileExists(".codex/auth.json"), false);
            interaction.notify({ type: "auth_url", url });
            interaction.notify({ type: "progress", message: "PRIVATE" });
            const controller = new AbortController();
            const manual = interaction
              .prompt({ type: "manual_code", signal: controller.signal })
              .catch(() => "cancelled");
            controller.abort();
            assert.equal(await manual, "cancelled");
            return { type: "oauth", access: "PRIVATE", refresh: "PRIVATE" };
          },
        };
      },
    },
  );
  assert.equal(checkedModels, true);
  assert.equal(closed, true);
  assert.deepEqual(result, { type: "login_result", connected: true });
  assert.deepEqual(events, [{ type: "auth_url", url }, { type: "login_progress" }]);
  assert.equal(JSON.stringify({ result, events }).includes("PRIVATE"), false);
});

test("an already cancelled login does not configure models and always closes its store", async () => {
  let closed = false;
  let created = false;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    loginWithPi(
      { authPath: "fixture", signal: controller.signal, emit() {} },
      {
        store: () => ({
          close: async () => {
            closed = true;
          },
        }),
        models: () => {
          created = true;
        },
      },
    ),
  );
  assert.equal(created, false);
  assert.equal(closed, true);
});

test("model close failure cannot leak the credential store owner", async () => {
  let closed = false;
  await assert.rejects(
    loginWithPi(
      { authPath: "fixture", signal: new AbortController().signal, emit() {} },
      {
        store: () => ({
          deviceId: async () => device,
          close: async () => {
            closed = true;
          },
        }),
        provider,
        models: () => ({
          setProvider() {},
          login: async () => ({ type: "oauth" }),
          close: async () => {
            throw new Error("PRIVATE");
          },
        }),
      },
    ),
  );
  assert.equal(closed, true);
});

test("entry refuses invalid arguments and CLI credential paths without disclosing them", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-auth-entry-"));
  try {
    const entry = fileURLToPath(new URL("./auth-main.mjs", import.meta.url));
    const badArgs = spawnSync(
      process.execPath,
      [entry, "--login", "--auth-path", "relative-PRIVATE"],
      { encoding: "utf8" },
    );
    assert.equal(badArgs.status, 2);
    assert.deepEqual(JSON.parse(badArgs.stdout), {
      type: "auth_error",
      code: "configuration_invalid",
    });
    assert.equal(badArgs.stdout.includes("PRIVATE"), false);
    const forbidden = join(directory, ".codex", "auth.json");
    const blocked = spawnSync(process.execPath, [entry, "--login", "--auth-path", forbidden], {
      encoding: "utf8",
    });
    assert.equal(blocked.status, 1);
    assert.deepEqual(JSON.parse(blocked.stdout), { type: "auth_error", code: "login_failed" });
    assert.equal(blocked.stdout.includes(directory), false);
    assert.equal(existsSync(join(directory, ".codex")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

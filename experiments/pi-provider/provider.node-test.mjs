import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loginWithPi } from "./login.mjs";
import { driverPath } from "./pi.mjs";
import { PiCredentialStore } from "./store.mjs";

const here = dirname(fileURLToPath(import.meta.url));
await mkdir(join(here, "artifacts"), { recursive: true, mode: 0o700 });
const fixtures = await mkdtemp(join(here, "artifacts", "offline-"));
async function location(name) {
  const path = join(fixtures, name);
  await mkdir(path, { mode: 0o700 });
  return join(path, "auth.json");
}
function check(authPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [driverPath, "--check", "--auth-path", authPath], {
      env: {},
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("actual Pi static model mapping: check emits metadata only, no credential creation or model calls", async () => {
  const path = await location("readiness");
  const initial = await check(path);
  assert.equal(initial.code, 0, initial.stderr);
  assert.deepEqual(JSON.parse(initial.stdout), {
    type: "readiness",
    provider: "openai",
    model: "gpt-6.1-sol",
    modelInCatalog: true,
    authMethods: ["oauth", "api_key"],
    credentialPresent: false,
    credentialType: null,
    networkVerified: false,
  });
  await assert.rejects(stat(path), { code: "ENOENT" });
  const store = new PiCredentialStore(path);
  await store.modify("openai", async () => ({
    type: "oauth",
    refresh: "FAKE_REFRESH_SECRET",
    access: "FAKE_ACCESS_SECRET",
    expires: 0,
  }));
  await store.close();
  const present = await check(path);
  assert.equal(present.code, 0, present.stderr);
  assert.equal(JSON.parse(present.stdout).credentialType, "oauth");
  assert.equal(JSON.parse(present.stdout).credentialPresent, true);
  assert.doesNotMatch(present.stdout + present.stderr, /FAKE_.*SECRET/);
});

test("atomic0600 credentials serialize refresh updates and persist stable installation UUID", async () => {
  const path = await location("refresh");
  const store = new PiCredentialStore(path);
  const deviceId = store.deviceId();
  await store.modify("openai", async () => ({
    type: "oauth",
    access: "fake",
    refresh: "fake",
    expires: 0,
    count: 0,
  }));
  await Promise.all(
    Array.from({ length: 10 }, () =>
      store.modify("openai", async (prior) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { ...prior, count: prior.count + 1 };
      }),
    ),
  );
  assert.equal((await store.read("openai")).count, 10);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(dirname(path), "installation.json"))).mode & 0o777, 0o600);
  assert.deepEqual(await store.list(), [{ providerId: "openai", type: "oauth" }]);
  const contender = await check(path);
  assert.notEqual(contender.code, 0);
  assert.deepEqual(JSON.parse(contender.stdout), {
    type: "driver_error",
    reason: "storage_or_configuration_error",
  });
  await store.close();
  const reopened = new PiCredentialStore(path);
  assert.equal(reopened.deviceId(), deviceId);
  assert.equal((await reopened.read("openai")).count, 10);
  await reopened.close();
});

test("mock login uses Pi API contract and returns no credential body", async () => {
  const path = await location("mock-login");
  const store = new PiCredentialStore(path);
  let called = false;
  const interaction = {
    notify() {},
    async prompt() {
      return "fixture callback";
    },
  };
  const models = {
    async login(provider, type, actualInteraction, options) {
      called = true;
      assert.equal(provider, "openai");
      assert.equal(type, "oauth");
      assert.equal(options.agentName, "Yorishiro");
      assert.equal(options.getDeviceId(), store.deviceId());
      assert.equal(actualInteraction.notify, interaction.notify);
      const credential = {
        type: "oauth",
        access: "FAKE_ACCESS_SECRET",
        refresh: "FAKE_REFRESH_SECRET",
        expires: 123,
      };
      await store.modify(provider, async () => credential);
      return credential;
    },
  };
  const result = await loginWithPi({
    models,
    store,
    interaction,
    signal: new AbortController().signal,
  });
  assert.equal(called, true);
  assert.deepEqual(result, { provider: "openai", type: "oauth", connected: true });
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  await store.close();
});

test("unsafe credential files and malformed secret JSON fail without exposing bodies", async () => {
  const path = await location("unsafe");
  const target = join(dirname(path), "secret-target.json");
  await writeFile(target, "{FAKE_PRIVATE_SECRET", { mode: 0o600 });
  await symlink(target, path);
  const store = new PiCredentialStore(path);
  await assert.rejects(store.list(), /private regular file/);
  await store.close();
  const malformed = await location("malformed");
  await writeFile(malformed, "{FAKE_PRIVATE_SECRET", { mode: 0o600 });
  const result = await check(malformed);
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /FAKE_PRIVATE_SECRET/);
  assert.equal(await readFile(target, "utf8"), "{FAKE_PRIVATE_SECRET");
  const invalidPath = await location("not-a-file");
  await mkdir(invalidPath, { mode: 0o700 });
  const unavailable = await check(invalidPath);
  assert.notEqual(unavailable.code, 0);
  assert.deepEqual(JSON.parse(unavailable.stdout), {
    type: "driver_error",
    reason: "storage_or_configuration_error",
  });
});

test("process owner lock rejects a competing driver and releases after SIGKILL", {
  timeout: 10000,
}, async (t) => {
  const path = await location("process-lock");
  const storeUrl = new URL("store.mjs", import.meta.url).href;
  const source = `const {PiCredentialStore}=await import(${JSON.stringify(storeUrl)}); new PiCredentialStore(process.argv[1]); process.stdout.write("ready\\n"); setInterval(()=>{},1000);`;
  const holder = spawn(process.execPath, ["--input-type=module", "-e", source, path], {
    env: {},
    stdio: "pipe",
  });
  t.after(() => holder.kill("SIGKILL"));
  holder.stderr.resume();
  await once(holder.stdout, "data");
  const rejected = await check(path);
  assert.notEqual(rejected.code, 0);
  assert.equal(JSON.parse(rejected.stdout).type, "driver_error");
  const exited = once(holder, "exit");
  holder.kill("SIGKILL");
  assert.equal((await exited)[1], "SIGKILL");
  const recovered = await check(path);
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).credentialPresent, false);
});

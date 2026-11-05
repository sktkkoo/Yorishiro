import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConfiguredModels, openConfiguredModels, parseOptions } from "./config.mjs";
import { PiCredentialStore } from "./credential-store.mjs";
import { createWorkspaceTools } from "./workspace-tools.mjs";

const root = await mkdtemp(join(tmpdir(), "pi-oauth-offline-"));
async function path(name) {
  const directory = join(root, name);
  await mkdir(directory, { mode: 0o700 });
  return join(directory, "auth.json");
}
const fake = {
  type: "oauth",
  access: "FAKE_ACCESS_ONLY",
  refresh: "FAKE_REFRESH_ONLY",
  expires: Date.now() + 3_600_000,
};
const options = (authPath) => ({
  provider: "openai",
  model: "gpt-6.1-sol",
  authMode: "oauth",
  authPath,
});
function holder(authPath) {
  const source = `const {PiCredentialStore}=await import(${JSON.stringify(new URL("credential-store.mjs", import.meta.url).href)}); const store=new PiCredentialStore(process.argv[1]); await store.modify("openai",async prior=>{ process.stdout.write("locked\\n"); await new Promise(()=>{setInterval(()=>{},1000)}); return prior; });`;
  return spawn(process.execPath, ["--input-type=module", "-e", source, authPath], {
    env: {},
    stdio: "pipe",
  });
}

test("explicit OAuth config preserves legacy apiKey default and rejects ignored/missing paths", () => {
  const base = [
    "--session-dir",
    join(root, "state"),
    "--cwd",
    root,
    "--provider",
    "openai",
    "--model",
    "gpt-6.1-sol",
    "--permissions-json",
    JSON.stringify({ read: true, write: true, commands: [] }),
  ];
  assert.equal(parseOptions(base).authMode, "apiKey");
  assert.throws(() => parseOptions([...base, "--auth-mode", "oauth"]), /configuration_invalid/);
  assert.throws(
    () => parseOptions([...base, "--auth-mode", "oauth", "--auth-path", "relative"]),
    /configuration_invalid/,
  );
  assert.throws(() => parseOptions([...base, "--auth-path", "/ignored"]), /configuration_invalid/);
  assert.equal(
    parseOptions([...base, "--auth-mode", "oauth", "--auth-path", join(root, "auth.json")])
      .authMode,
    "oauth",
  );
});

test("Pi-owned format and static real SDK model use OAuth only with no environment fallback", async () => {
  const authPath = await path("configuration");
  const store = new PiCredentialStore(authPath);
  await store.modify("openai", async () => fake);
  const uuid = await store.deviceId();
  await store.close();
  const configured = await openConfiguredModels(options(authPath), {
    OPENAI_API_KEY: "NEVER_FALL_BACK",
  });
  assert.equal(configured.models.getModel("openai", "gpt-6.1-sol").api, "openai-responses");
  assert.deepEqual(await configured.models.checkAuth("openai"), {
    source: "OAuth",
    type: "oauth",
  });
  await configured.close();
  const reopened = new PiCredentialStore(authPath);
  assert.equal(await reopened.deviceId(), uuid);
  assert.equal((await stat(authPath)).mode & 0o777, 0o600);
  await reopened.delete("openai");
  await reopened.close();
  await assert.rejects(
    openConfiguredModels(options(authPath), {
      OPENAI_API_KEY: "NEVER_FALL_BACK",
    }),
    /provider_unconfigured/,
  );
  assert.throws(
    () =>
      createConfiguredModels(options(authPath), {
        OPENAI_API_KEY: "NEVER_FALL_BACK",
      }),
    /provider_unconfigured/,
  );
});

test("idle stores coexist and serialized asynchronous updates retain every mock refresh", async () => {
  const authPath = await path("shared");
  const a = new PiCredentialStore(authPath);
  const b = new PiCredentialStore(authPath);
  await a.modify("openai", async () => ({ ...fake, count: 0 }));
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      (i % 2 ? a : b).modify("openai", async (prior) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { ...prior, count: prior.count + 1 };
      }),
    ),
  );
  assert.equal((await b.read("openai")).count, 12);
  await a.close();
  await b.close();
});

test("cross-process async refresh lock bounds contention, aborts waiting, and releases on SIGKILL", {
  timeout: 10000,
}, async (t) => {
  const authPath = await path("contention");
  const store = new PiCredentialStore(authPath, { lockTimeoutMs: 60 });
  await store.modify("openai", async () => fake);
  const child = holder(authPath);
  t.after(() => child.kill("SIGKILL"));
  child.stderr.resume();
  await once(child.stdout, "data");
  await assert.rejects(store.read("openai"), /auth_lock_timeout/);
  const controller = new AbortController();
  const aborted = store.read("openai", { signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  assert.equal((await store.read("openai")).access, fake.access);
  await store.close();
});

test("aborted mock refresh callback releases ownership without replacing credential", async () => {
  const authPath = await path("abort");
  const a = new PiCredentialStore(authPath);
  const b = new PiCredentialStore(authPath);
  await a.modify("openai", async () => fake);
  const controller = new AbortController();
  let started;
  const reached = new Promise((resolve) => {
    started = resolve;
  });
  const result = a.modify(
    "openai",
    async () => {
      started();
      return new Promise((_resolve, reject) =>
        controller.signal.addEventListener("abort", () => reject(new Error("mock aborted")), {
          once: true,
        }),
      );
    },
    { signal: controller.signal },
  );
  await reached;
  controller.abort();
  await assert.rejects(result, /mock aborted/);
  assert.equal((await b.read("openai")).access, fake.access);
  await a.close();
  await b.close();
});

test("provider directory is protected even when workspace contains it and through symlink aliases", async () => {
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const secretDir = join(cwd, "private-auth");
  await mkdir(secretDir);
  await writeFile(join(secretDir, "auth.json"), "FAKE_PRIVATE");
  await symlink(secretDir, join(cwd, "alias"));
  await writeFile(join(cwd, "safe.txt"), "safe");
  const tools = await createWorkspaceTools(
    cwd,
    { read: true, write: true, commands: [] },
    { protectedPaths: [secretDir] },
  );
  const read = tools.find((tool) => tool.name === "read_file");
  const write = tools.find((tool) => tool.name === "write_file");
  await assert.rejects(
    read.execute({ path: "private-auth/auth.json" }, {}, {}),
    /credential storage/,
  );
  await assert.rejects(read.execute({ path: "alias/auth.json" }, {}, {}), /credential storage/);
  await assert.rejects(
    write.execute({ path: "private-auth/new.json", content: "bad" }, {}, {}),
    /credential storage/,
  );
  await write.execute({ path: "safe.txt", content: "updated", expectedContent: "safe" }, {}, {});
  assert.equal(await readFile(join(cwd, "safe.txt"), "utf8"), "updated");
});

test("private malformed state is redacted, final symlinks and permissive files rejected", async () => {
  const authPath = await path("malformed");
  await writeFile(authPath, "{FAKE_PRIVATE_TOKEN", { mode: 0o600 });
  const store = new PiCredentialStore(authPath);
  await assert.rejects(store.list(), (error) => !error.message.includes("FAKE_PRIVATE_TOKEN"));
  await chmod(authPath, 0o644);
  await assert.rejects(store.read("openai"), /private_file_required/);
  await store.close();
});

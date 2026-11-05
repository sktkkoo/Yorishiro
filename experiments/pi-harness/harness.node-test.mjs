import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
await mkdir(join(here, "artifacts"), { recursive: true });
const artifacts = await mkdtemp(join(here, "artifacts", "evaluation-"));

async function childRun(mode, scratch, requestId) {
  return new Promise((resolve, reject) => {
    // Clear inherited variables, including provider credentials; fake model only.
    const child = fork(join(here, "worker.mjs"), [mode, scratch, requestId], {
      env: {},
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const messages = [];
    let stderr = "";
    let stdout = "";
    let killedAfterEffect = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Worker timeout (${mode}): ${stderr}`));
    }, 15000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("message", (message) => {
      messages.push(message);
      if (mode === "crash" && message.type === "effect-applied") {
        killedAfterEffect = true;
        child.kill("SIGKILL");
      }
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ mode, code, signal, killedAfterEffect, messages, stderr, stdout });
    });
  });
}

async function effectCount(scratch) {
  return (await readFile(join(scratch, "effects.jsonl"), "utf8")).trim().split("\n").length;
}

test("SQLite reopen and identical requestId return original result without repeating side effect", async (t) => {
  const scratch = join(artifacts, "completed");
  await mkdir(scratch);
  const first = await childRun("complete", scratch, "fixture-completed-request");
  assert.equal(first.code, 0, first.stderr);
  const one = first.messages.find((message) => message.type === "result");
  assert.equal(one.status, "done");
  assert.equal(one.modelCalls, 2);
  assert.equal(one.toolResults.length, 1);
  assert.equal(one.toolResults[0].isError, false);
  assert.equal(await effectCount(scratch), 1);
  const reopened = await childRun("recover", scratch, "fixture-completed-request");
  assert.equal(reopened.code, 0, reopened.stderr);
  const two = reopened.messages.find((message) => message.type === "result");
  assert.equal(two.submissionId, one.submissionId);
  assert.equal(two.status, "done");
  assert.equal(two.modelCalls, 0);
  assert.equal(await effectCount(scratch), 1);
  await writeFile(join(scratch, "evidence.json"), JSON.stringify({ first, reopened }, null, 2));
  t.diagnostic(`Retained SQLite, scratch effect and process evidence: ${scratch}`);
});

test("SIGKILL after unsafe tool effect recovers interrupted result without replaying effect", async (t) => {
  const scratch = join(artifacts, "interrupted");
  await mkdir(scratch);
  const crashed = await childRun("crash", scratch, "fixture-interrupted-request");
  assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
  assert.equal(crashed.killedAfterEffect, true);
  assert.equal(await effectCount(scratch), 1);
  const reopened = await childRun("recover", scratch, "fixture-interrupted-request");
  assert.equal(reopened.code, 0, reopened.stderr);
  const result = reopened.messages.find((message) => message.type === "result");
  assert.equal(result.status, "done");
  assert.equal(result.modelCalls, 1);
  assert.equal(result.toolResults.length, 1);
  assert.equal(result.toolResults[0].isError, true);
  assert.match(JSON.stringify(result.toolResults[0]), /interrupted/i);
  assert.equal(await effectCount(scratch), 1);
  const admitted = crashed.messages.find((message) => message.type === "admitted");
  assert.equal(result.submissionId, admitted.submissionId);
  await writeFile(join(scratch, "evidence.json"), JSON.stringify({ crashed, reopened }, null, 2));
  t.diagnostic(`Retained SQLite, scratch effect and process evidence: ${scratch}`);
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { obj } from "@earendil-works/pi-schema";
import { describeSubmissionTools } from "./submission-evidence.mjs";

const here = dirname(fileURLToPath(import.meta.url));
await mkdir(join(here, "artifacts"), { recursive: true });
const artifacts = await mkdtemp(join(here, "artifacts", "stdio-"));

function client(scratch, hold = false) {
  const process = spawn(
    globalThis.process.execPath,
    [join(here, "sidecar.mjs"), "--fixture", scratch, ...(hold ? ["--hold-tool"] : [])],
    { env: {}, stdio: ["pipe", "pipe", "pipe"] },
  );
  const records = [];
  let buffered = "";
  let stderr = "";
  let exit;
  let notify = () => {};
  process.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  process.stdout.setEncoding("utf8");
  process.stdout.on("data", (chunk) => {
    buffered += chunk;
    while (true) {
      const end = buffered.indexOf("\n");
      if (end < 0) break;
      records.push(JSON.parse(buffered.slice(0, end)));
      buffered = buffered.slice(end + 1);
    }
    notify();
  });
  const exited = new Promise((resolve) =>
    process.on("exit", (code, signal) => {
      exit = { code, signal };
      notify();
      resolve(exit);
    }),
  );
  async function wait(predicate) {
    const deadline = Date.now() + 10000;
    while (true) {
      const record = records.find(predicate);
      if (record) return record;
      if (exit) throw new Error(`Sidecar exited ${JSON.stringify(exit)}: ${stderr}`);
      if (Date.now() > deadline) throw new Error(`Sidecar observation deadline: ${stderr}`);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 20);
        notify = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }
  async function send(record) {
    if (!process.stdin.write(`${JSON.stringify(record)}\n`)) await once(process.stdin, "drain");
  }
  return {
    process,
    records,
    exited,
    wait,
    send,
    async call(record) {
      await send(record);
      return wait((value) => value.type === "response" && value.id === record.id);
    },
    async shutdown() {
      const response = await this.call({ id: "shutdown", type: "shutdown" });
      assert.equal(response.success, true);
      process.stdin.end();
      assert.deepEqual(await exited, { code: 0, signal: null });
    },
  };
}

test("fixture must be explicit; no unconfigured provider silently becomes fake", {
  timeout: 10000,
}, async () => {
  const process = spawn(globalThis.process.execPath, [join(here, "sidecar.mjs")], {
    env: {},
    stdio: "pipe",
  });
  let stderr = "";
  process.stdout.resume();
  process.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(process, "exit");
  assert.equal(code, 2);
  assert.match(stderr, /Unconfigured provider/);
});

test("exclusive owner rejects a concurrent sidecar, SIGKILL releases ownership, passive reopen resumes original submission", {
  timeout: 15000,
}, async (t) => {
  const scratch = join(artifacts, "recovery");
  await mkdir(scratch);
  const first = client(scratch, true);
  t.after(() => first.process.kill("SIGKILL"));
  const ready = await first.wait((r) => r.type === "ready");
  assert.equal(ready.protocol, 2);
  assert.equal(ready.fixture, true);
  assert.equal(ready.sessionDir, scratch);
  assert.equal(ready.cwd, scratch);
  const initial = await first.call({ id: "inspect-new", type: "status" });
  assert.equal(initial.data.modelCalls, 0);
  const accepted = await first.call({
    id: "submit-command",
    type: "submit",
    requestId: "durable-stdio-1",
    message: "Fixture input with a Unicode line separator:\u2028still one record",
  });
  assert.equal(accepted.data.disposition, "accepted");
  assert.notEqual(accepted.data.status, "done");
  await first.wait((r) => r.type === "tool_effect");
  assert.equal(
    first.records.some((r) => r.type === "settled"),
    false,
  );
  const contender = client(scratch);
  t.after(() => contender.process.kill("SIGKILL"));
  assert.deepEqual(await contender.exited, { code: 3, signal: null });
  assert.deepEqual(contender.records, [{ type: "startup_error", code: "storage_owned" }]);
  const stillOwner = await first.call({
    id: "still-owner",
    type: "status",
    submissionId: accepted.data.submissionId,
  });
  assert.equal(stillOwner.data.modelCalls, 1);
  assert.equal(
    (await readFile(join(scratch, "effects.jsonl"), "utf8")).trim().split("\n").length,
    1,
  );
  first.process.kill("SIGKILL");
  assert.equal((await first.exited).signal, "SIGKILL");

  const second = client(scratch);
  t.after(() => second.process.kill("SIGKILL"));
  await second.wait((r) => r.type === "ready");
  const sid = accepted.data.submissionId;
  const missing = await second.call({
    id: "missing-request",
    type: "status",
    requestId: "missing",
  });
  assert.equal(missing.success, true, missing.error);
  assert.equal(missing.data.found, false);
  assert.equal(missing.data.modelCalls, 0);
  const before = await second.call({
    id: "inspect-reopen",
    type: "status",
    requestId: "durable-stdio-1",
  });
  assert.equal(before.data.found, true);
  assert.equal(before.data.submissionId, sid);
  assert.equal(before.data.requestId, "durable-stdio-1");
  assert.equal(before.data.modelCalls, 0);
  assert.equal(before.data.toolEvidenceComplete, false);
  assert.deepEqual(before.data.toolResults, []);
  assert.notEqual(before.data.status, "done");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const still = await second.call({
    id: "inspect-still-passive",
    type: "status",
    submissionId: sid,
  });
  assert.equal(still.data.modelCalls, 0);
  const mismatch = await second.call({
    id: "mismatched-request",
    type: "resume",
    requestId: "missing",
    submissionId: sid,
  });
  assert.equal(mismatch.success, false);
  const resuming = await second.call({
    id: "resume-command",
    type: "resume",
    requestId: "durable-stdio-1",
  });
  assert.equal(resuming.data.disposition, "resuming");
  const settled = await second.wait((r) => r.type === "settled" && r.submissionId === sid);
  assert.equal(settled.status, "done");
  assert.equal(settled.modelCalls, 1);
  assert.match(settled.report.reply, /Deterministic fixture/);
  assert.equal(settled.toolEvidenceComplete, true);
  assert.equal(settled.toolResults.length, 1);
  assert.equal(settled.toolResults[0].isError, true);
  assert.equal(settled.toolResults[0].interrupted, true);
  assert.equal(typeof settled.toolResults[0].entryId, "number");
  assert.equal(settled.toolResults[0].toolCallId, "sidecar-effect");
  const repeated = await second.call({
    id: "dedup-command",
    type: "submit",
    requestId: "durable-stdio-1",
    message: "same durable request",
  });
  assert.equal(repeated.data.submissionId, sid);
  const after = await second.call({ id: "inspect-dedup", type: "status", submissionId: sid });
  assert.equal(after.data.modelCalls, 1);
  const independent = await second.call({
    id: "independent-command",
    type: "submit",
    requestId: "new-independent-request",
    message: "Answer without borrowing the interrupted tool of the old request",
  });
  assert.notEqual(independent.data.submissionId, sid);
  const independentDone = await second.wait(
    (r) => r.type === "settled" && r.submissionId === independent.data.submissionId,
  );
  assert.equal(independentDone.status, "done");
  assert.equal(independentDone.toolEvidenceComplete, true);
  assert.deepEqual(independentDone.toolResults, []);
  const originalAgain = await second.call({
    id: "old-after-new-request",
    type: "status",
    submissionId: sid,
  });
  assert.deepEqual(originalAgain.data.toolResults, settled.toolResults);
  assert.equal(
    (await readFile(join(scratch, "effects.jsonl"), "utf8")).trim().split("\n").length,
    1,
  );
  await second.shutdown();
  const afterShutdown = client(scratch);
  t.after(() => afterShutdown.process.kill("SIGKILL"));
  await afterShutdown.wait((r) => r.type === "ready");
  const cleanRelease = await afterShutdown.call({
    id: "after-clean-release",
    type: "status",
    submissionId: sid,
  });
  assert.equal(cleanRelease.data.status, "done");
  assert.equal(cleanRelease.data.modelCalls, 0);
  await afterShutdown.shutdown();
  await writeFile(
    join(scratch, "stdio-evidence.json"),
    JSON.stringify(
      {
        first: first.records,
        rejectedContender: contender.records,
        second: second.records,
        afterShutdown: afterShutdown.records,
      },
      null,
      2,
    ),
  );
  t.diagnostic(`Actual Pi SQLite/JSONL evidence: ${scratch}`);
});

test("submission tool evidence paginates actual SQLite history and excludes later inputs", {
  timeout: 20000,
}, async (t) => {
  const scratch = join(artifacts, "paginated-evidence");
  await mkdir(scratch);
  const context = BACKGROUND_CONTEXT;
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      Array.from({ length: 105 }, (_, index) =>
        fauxToolCall("noop", {}, { id: `page-tool-${index}` }),
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("The first fixture has finished."),
    fauxAssistantMessage("A later fixture without any tool calls."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "pagination-fixture",
      tools: [
        defineTool({
          name: "noop",
          description: "Return a deterministic fixture observation",
          parameters: obj({}),
          execute: async () => ({ output: [{ type: "text", text: "observed" }] }),
        }),
      ],
    }),
  );
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(scratch, "session.sqlite")),
    { models, registry },
    context,
  );
  try {
    const root = await harness.root(context, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });
    const first = await root.submit(
      { type: "input", content: "First input", requestId: "pages" },
      context,
    );
    const firstRecord = await first.wait(context);
    assert.equal(firstRecord.status, "done");
    const later = await root.submit(
      { type: "input", content: "Later input", requestId: "later" },
      context,
    );
    const laterRecord = await later.wait(context);
    const firstEvidence = await describeSubmissionTools(root, firstRecord, context);
    assert.equal(firstEvidence.toolEvidenceComplete, true);
    assert.equal(firstEvidence.toolResults.length, 105);
    assert.equal(new Set(firstEvidence.toolResults.map((r) => r.toolCallId)).size, 105);
    assert.ok(
      firstEvidence.toolResults.every(
        (r) => r.entryId >= firstRecord.entry && r.entryId <= firstRecord.answer && !r.isError,
      ),
    );
    const laterEvidence = await describeSubmissionTools(root, laterRecord, context);
    assert.equal(laterEvidence.toolEvidenceComplete, true);
    assert.deepEqual(laterEvidence.toolResults, []);
    await writeFile(
      join(scratch, "evidence.json"),
      JSON.stringify({ firstRecord, laterRecord, firstEvidence, laterEvidence }, null, 2),
    );
    t.diagnostic(`Actual Pi pagination evidence: ${scratch}`);
  } finally {
    await harness.close(context);
  }
});

test("paused stdout reader drains correlated responses after backpressure without starting model work", {
  timeout: 15000,
}, async (t) => {
  const scratch = join(artifacts, "backpressure");
  await mkdir(scratch);
  const sidecar = client(scratch);
  t.after(() => sidecar.process.kill("SIGKILL"));
  await sidecar.wait((r) => r.type === "ready");
  sidecar.process.stdout.pause();
  const ids = Array.from({ length: 160 }, (_, i) => `status-${i}-${"x".repeat(2048)}`);
  const sending = (async () => {
    for (const id of ids) await sidecar.send({ id, type: "status" });
  })();
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Resume consuming the actual pipe, whose capacity is smaller than the replies.
  sidecar.process.stdout.resume();
  await sending;
  await sidecar.wait((r) => r.id === ids.at(-1));
  for (const id of ids) {
    const response = sidecar.records.find((r) => r.id === id);
    assert.equal(response.success, true);
    assert.equal(response.data.modelCalls, 0);
  }
  assert.equal(
    sidecar.records.some((r) => r.type === "tool_effect"),
    false,
  );
  await sidecar.shutdown();
  t.diagnostic(
    "160 correlated status responses recovered after paused-reader pipe pressure; zero model calls",
  );
});

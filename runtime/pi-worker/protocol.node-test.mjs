import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const here = dirname(fileURLToPath(import.meta.url));
const permissions = { read: true, write: false, commands: [] };
function client(cwd, sessionDir, policy = permissions, scenario = "read") {
  const child = spawn(
    process.execPath,
    [join(here, "tests/fixture-entry.mjs"), cwd, sessionDir, JSON.stringify(policy), scenario],
    { env: {}, stdio: "pipe" },
  );
  const records = [];
  let buffered = "";
  let stderr = "";
  let result;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    for (;;) {
      const end = buffered.indexOf("\n");
      if (end < 0) break;
      records.push(JSON.parse(buffered.slice(0, end)));
      buffered = buffered.slice(end + 1);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = once(child, "exit").then(([code, signal]) => {
    result = { code, signal };
    return result;
  });
  const wait = async (predicate) => {
    const deadline = Date.now() + 6000;
    for (;;) {
      const record = records.find(predicate);
      if (record) return record;
      if (result) throw new Error(`Fixture exit ${JSON.stringify(result)} ${stderr}`);
      if (Date.now() >= deadline) throw new Error("Fixture observation deadline");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return {
    child,
    records,
    exited,
    wait,
    async call(record) {
      if (!child.stdin.write(`${JSON.stringify(record)}\n`)) await once(child.stdin, "drain");
      return wait((value) => value.type === "response" && value.id === record.id);
    },
    async close() {
      const reply = await this.call({ id: "close", type: "shutdown" });
      assert.equal(reply.success, true);
      child.stdin.end();
      assert.deepEqual(await exited, { code: 0, signal: null });
    },
  };
}

test("actual Harness creates, edits and verifies an artifact through explicit tools, then recovers without replay", {
  timeout: 15000,
}, async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-production-create-"));
  const cwd = join(scratch, "workspace");
  await mkdir(cwd);
  const storage = join(scratch, "storage");
  const policy = {
    read: true,
    write: true,
    commands: [
      {
        id: "verify",
        program: process.execPath,
        args: [
          "-e",
          "const fs=require('node:fs');if(fs.readFileSync('result.txt','utf8')!=='two')process.exit(2);fs.appendFileSync('command-effects.txt','verified\\n');console.log('verified');",
        ],
      },
    ],
  };
  const first = client(cwd, storage, policy, "create");
  t.after(() => first.child.kill("SIGKILL"));
  const ready = await first.wait((record) => record.type === "ready");
  assert.equal(ready.admission.version, 1);
  assert.equal(ready.admission.rootId, ready.conversationId);
  assert.match(ready.admission.epoch, /^[0-9a-f-]{36}$/);
  for (const [index, admission] of [
    { ...ready.admission, epoch: "expired" },
    { ...ready.admission, rootId: ready.admission.rootId + 1 },
    { ...ready.admission, extra: "forbidden" },
  ].entries()) {
    const denied = await first.call({
      id: `deny-${index}`,
      type: "submit",
      requestId: `denied-${index}`,
      message: "Create and verify the fixture artifact",
      admission,
    });
    assert.equal(denied.success, false);
    assert.equal(denied.error, "admission_mismatch");
    const absent = await first.call({
      id: `absent-${index}`,
      type: "status",
      requestId: `denied-${index}`,
    });
    assert.equal(absent.data.found, false);
    assert.equal(absent.data.modelCalls, 0);
  }
  await assert.rejects(access(join(cwd, "result.txt")));
  await assert.rejects(access(join(cwd, "command-effects.txt")));
  const accepted = await first.call({
    id: "create",
    type: "submit",
    requestId: "create-1",
    message: "Create and verify the fixture artifact",
    admission: ready.admission,
  });
  assert.equal(accepted.success, true);
  const settled = await first.wait((record) => record.type === "settled");
  assert.equal(settled.status, "done");
  assert.equal(settled.modelCalls, 4);
  assert.equal(settled.toolResults.length, 3);
  assert.ok(settled.toolResults.every((result) => !result.isError));
  assert.equal(settled.toolEvidenceComplete, true);
  assert.equal(await readFile(join(cwd, "result.txt"), "utf8"), "two");
  assert.equal(await readFile(join(cwd, "command-effects.txt"), "utf8"), "verified\n");
  const liveDuplicate = await first.call({
    id: "live-duplicate",
    type: "submit",
    requestId: "create-1",
    message: "Create and verify the fixture artifact",
    admission: ready.admission,
  });
  assert.equal(liveDuplicate.data.submissionId, settled.submissionId);
  await first.close();
  const second = client(cwd, storage, policy, "create");
  t.after(() => second.child.kill("SIGKILL"));
  const reopenedReady = await second.wait((record) => record.type === "ready");
  assert.deepEqual(reopenedReady.admission, ready.admission);
  const repeated = await second.call({
    id: "repeat",
    type: "submit",
    requestId: "create-1",
    message: "Create and verify the fixture artifact",
    admission: ready.admission,
  });
  assert.equal(repeated.data.submissionId, settled.submissionId);
  const recovered = await second.call({ id: "recovered", type: "status", requestId: "create-1" });
  assert.equal(recovered.data.modelCalls, 0);
  assert.equal(await readFile(join(cwd, "command-effects.txt"), "utf8"), "verified\n");
  await writeFile(
    join(scratch, "evidence.json"),
    JSON.stringify(
      {
        fixture: true,
        model: "deterministic faux provider; no network",
        submissionId: settled.submissionId,
        first: settled,
        recovered: recovered.data,
        artifact: "two",
        commandEffects: 1,
      },
      null,
      2,
    ),
  );
  await second.close();
  const database = new DatabaseSync(join(storage, "session.sqlite"));
  assert.equal(database.prepare("SELECT count(*) AS count FROM submissions").get().count, 1);
  database.close();
  t.diagnostic(`Retained actual Harness artifact evidence: ${scratch}`);
});

test("actual Pi database epoch survives process death and rejects an outbox from a replaced database", {
  timeout: 15000,
}, async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-production-epoch-"));
  const cwd = join(scratch, "workspace");
  const storage = join(scratch, "storage");
  await mkdir(cwd);
  await writeFile(join(cwd, "input.txt"), "fixture evidence");
  const first = client(cwd, storage);
  t.after(() => first.child.kill("SIGKILL"));
  const initial = await first.wait((record) => record.type === "ready");
  first.child.kill("SIGKILL");
  assert.deepEqual(await first.exited, { code: null, signal: "SIGKILL" });
  const reopened = client(cwd, storage);
  t.after(() => reopened.child.kill("SIGKILL"));
  const stable = await reopened.wait((record) => record.type === "ready");
  assert.deepEqual(stable.admission, initial.admission);
  await reopened.close();
  await rename(join(storage, "session.sqlite"), join(storage, "previous.sqlite"));
  const replacement = client(cwd, storage);
  t.after(() => replacement.child.kill("SIGKILL"));
  const fresh = await replacement.wait((record) => record.type === "ready");
  assert.equal(fresh.admission.rootId, initial.admission.rootId);
  assert.notEqual(fresh.admission.epoch, initial.admission.epoch);
  const denied = await replacement.call({
    id: "old-outbox",
    type: "submit",
    requestId: "not-replayed",
    message: "Read the fixture evidence",
    admission: initial.admission,
  });
  assert.equal(denied.success, false);
  assert.equal(denied.error, "admission_mismatch");
  const absent = await replacement.call({
    id: "absent",
    type: "status",
    requestId: "not-replayed",
  });
  assert.equal(absent.data.found, false);
  assert.equal(absent.data.modelCalls, 0);
  await replacement.close();
});

test("production protocol runtime uses actual Pi tools, passive recovery and durable identity", {
  timeout: 15000,
}, async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-production-protocol-"));
  const cwd = join(scratch, "workspace");
  await mkdir(cwd);
  const storage = join(scratch, "storage");
  await writeFile(join(cwd, "input.txt"), "fixture evidence");
  const first = client(cwd, storage);
  t.after(() => first.child.kill("SIGKILL"));
  const ready = await first.wait((value) => value.type === "ready");
  assert.equal(ready.fixture, true);
  assert.equal(ready.protocol, 2);
  assert.deepEqual(ready.permissions, permissions);
  const missing = await first.call({ id: "initial", type: "status", requestId: "work-1" });
  assert.equal(missing.data.found, false);
  assert.equal(missing.data.modelCalls, 0);
  const admitted = await first.call({
    id: "send",
    type: "submit",
    requestId: "work-1",
    message: "Read input.txt and return the report.\u2028Keep one JSONL frame.",
    outputSchema: { type: "object" },
  });
  assert.equal(admitted.success, true);
  const settled = await first.wait((value) => value.type === "settled");
  assert.equal(settled.status, "done");
  assert.equal(settled.report.reply, "fixture only");
  assert.equal(settled.modelCalls, 2);
  assert.equal(settled.toolResults.length, 1);
  assert.equal(settled.toolResults[0].isError, false);
  assert.equal(settled.toolEvidenceComplete, true);
  const sid = settled.submissionId;
  await first.close();
  const reopened = client(cwd, storage);
  t.after(() => reopened.child.kill("SIGKILL"));
  await reopened.wait((value) => value.type === "ready");
  const recovered = await reopened.call({ id: "recover", type: "status", requestId: "work-1" });
  assert.equal(recovered.data.submissionId, sid);
  assert.equal(recovered.data.modelCalls, 0);
  const duplicate = await reopened.call({
    id: "duplicate",
    type: "submit",
    requestId: "work-1",
    message: "Read input.txt and return the report.\u2028Keep one JSONL frame.",
    outputSchema: { type: "object" },
  });
  assert.equal(duplicate.data.submissionId, sid);
  const stable = await reopened.call({ id: "stable", type: "status", requestId: "work-1" });
  assert.equal(stable.data.modelCalls, 0);
  const mismatch = await reopened.call({
    id: "mismatch",
    type: "resume",
    requestId: "missing",
    submissionId: sid,
  });
  assert.equal(mismatch.success, false);
  await reopened.close();
  const changed = client(cwd, storage, { ...permissions, write: true });
  t.after(() => changed.child.kill("SIGKILL"));
  assert.deepEqual(await changed.exited, { code: 2, signal: null });
  assert.equal(
    changed.records.some((record) => record.type === "ready"),
    false,
  );
});

test("distinct inputs in one worker each execute a read and keep evidence scoped while duplicate IDs do not rerun", {
  timeout: 15000,
}, async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-production-sequential-"));
  const cwd = join(scratch, "workspace");
  const storage = join(scratch, "storage");
  await mkdir(cwd);
  const worker = client(cwd, storage);
  t.after(() => worker.child.kill("SIGKILL"));
  const ready = await worker.wait((record) => record.type === "ready");
  const requests = [
    { requestId: "sequential-first", content: "FIRST_REQUEST_EVIDENCE" },
    { requestId: "sequential-second", content: "SECOND_REQUEST_EVIDENCE" },
  ];
  const completed = [];
  let modelCalls = 0;
  for (const request of requests) {
    await writeFile(join(cwd, "input.txt"), request.content);
    const accepted = await worker.call({
      id: `submit-${request.requestId}`,
      type: "submit",
      requestId: request.requestId,
      message: "Read input.txt and return the report.",
      admission: ready.admission,
    });
    assert.equal(accepted.success, true);
    const settled = await worker.wait(
      (record) => record.type === "settled" && record.requestId === request.requestId,
    );
    assert.equal(settled.status, "done");
    assert.equal(settled.submissionId, accepted.data.submissionId);
    assert.equal(settled.modelCalls - modelCalls, 2);
    modelCalls = settled.modelCalls;
    assert.equal(settled.toolResults.length, 1);
    assert.equal(settled.toolResults[0].isError, false);
    assert.equal(settled.toolEvidenceComplete, true);
    const { firstEntryId, lastEntryId } = settled.toolEvidenceRange;
    assert.ok(settled.toolResults[0].entryId > firstEntryId);
    assert.ok(settled.toolResults[0].entryId < lastEntryId);
    completed.push(settled);
  }
  assert.equal(modelCalls, 4);
  assert.notEqual(completed[0].submissionId, completed[1].submissionId);
  assert.ok(
    completed[0].toolEvidenceRange.lastEntryId < completed[1].toolEvidenceRange.firstEntryId,
  );
  assert.notEqual(completed[0].toolResults[0].entryId, completed[1].toolResults[0].entryId);
  for (const [index, request] of requests.entries()) {
    const duplicate = await worker.call({
      id: `duplicate-${request.requestId}`,
      type: "submit",
      requestId: request.requestId,
      message: "Read input.txt and return the report.",
      admission: ready.admission,
    });
    assert.equal(duplicate.success, true);
    assert.equal(duplicate.data.submissionId, completed[index].submissionId);
    const status = await worker.call({
      id: `status-${request.requestId}`,
      type: "status",
      requestId: request.requestId,
    });
    assert.equal(status.data.modelCalls, 4);
    assert.deepEqual(status.data.toolEvidenceRange, completed[index].toolEvidenceRange);
    assert.deepEqual(status.data.toolResults, completed[index].toolResults);
  }
  await worker.close();
  const database = new DatabaseSync(join(storage, "session.sqlite"));
  try {
    assert.equal(database.prepare("SELECT count(*) AS count FROM submissions").get().count, 2);
    for (const [index, settled] of completed.entries()) {
      const entry = JSON.parse(
        database
          .prepare("SELECT record FROM entries WHERE id = ?")
          .get(settled.toolResults[0].entryId).record,
      );
      const results = entry.model.filter((message) => message.role === "toolResult");
      assert.equal(results.length, 1);
      assert.equal(results[0].toolName, "read_file");
      assert.ok(JSON.stringify(results[0].content).includes(requests[index].content));
      assert.equal(JSON.stringify(results[0].content).includes(requests[1 - index].content), false);
    }
  } finally {
    database.close();
  }
});

for (const phase of ["before", "after"]) {
  test(`same durable payload recovers ${phase}-admission process death without duplicate effects`, {
    timeout: 15000,
  }, async (t) => {
    const scratch = await mkdtemp(join(tmpdir(), `pi-admission-${phase}-`));
    const cwd = join(scratch, "workspace");
    await mkdir(cwd);
    const storage = join(scratch, "storage");
    const policy = {
      read: true,
      write: true,
      commands: [
        {
          id: "verify",
          program: process.execPath,
          args: [
            "-e",
            "const fs=require('node:fs');if(fs.readFileSync('result.txt','utf8')!=='two')process.exit(2);fs.appendFileSync('command-effects.txt','verified\\n');",
          ],
        },
      ],
    };
    const message = "Create the durable admission fixture artifact";
    const outputSchema = { type: "object" };
    const requestPayload = JSON.stringify({ message, outputSchema });
    const requestDigest = createHash("sha256").update(requestPayload).digest("hex");
    const draft = {
      type: "submit",
      requestId: `admission-${phase}`,
      message,
      outputSchema,
      requestPayload,
      requestDigest,
    };
    if (phase === "before") {
      delete draft.message;
      delete draft.outputSchema;
    }
    const first = client(cwd, storage, policy, `${phase}-admission-create`);
    t.after(() => first.child.kill("SIGKILL"));
    const ready = await first.wait((r) => r.type === "ready");
    assert.equal(ready.idempotentSubmit, true);
    assert.equal(ready.requestDigestAlgorithm, "sha256-json-envelope-v1");
    const refused = await first.call({
      id: "wrong-managed-epoch",
      ...draft,
      admission: { ...ready.admission, epoch: "expired" },
    });
    assert.equal(refused.success, false);
    assert.equal(refused.error, "admission_mismatch");
    const notAdmitted = await first.call({
      id: "after-wrong-epoch",
      type: "status",
      requestId: draft.requestId,
    });
    assert.equal(notAdmitted.data.found, false);
    assert.equal(notAdmitted.data.requestDigest, null);
    draft.admission = ready.admission;
    first.child.stdin.write(`${JSON.stringify({ id: "lost-reply", ...draft })}\n`);
    await first.wait((r) => r.type === "fixture_barrier" && r.phase === phase);
    assert.equal(
      first.records.some((r) => r.type === "response" && r.id === "lost-reply"),
      false,
    );
    first.child.kill("SIGKILL");
    assert.equal((await first.exited).signal, "SIGKILL");
    const replacement = client(cwd, storage, policy, "create");
    t.after(() => replacement.child.kill("SIGKILL"));
    const replacementReady = await replacement.wait((r) => r.type === "ready");
    assert.deepEqual(replacementReady.admission, ready.admission);
    const status = await replacement.call({
      id: "inspect",
      type: "status",
      requestId: draft.requestId,
    });
    assert.equal(status.data.requestId, draft.requestId);
    assert.equal(status.data.found, phase === "after");
    assert.equal(status.data.requestDigest, phase === "after" ? requestDigest : null);
    assert.equal(status.data.modelCalls, 0);
    const admitted = await replacement.call({ id: "same-id-recovery", ...draft });
    assert.equal(admitted.success, true);
    assert.equal(admitted.data.requestDigest, requestDigest);
    if (phase === "after") assert.equal(admitted.data.submissionId, status.data.submissionId);
    const settled = await replacement.wait((r) => r.type === "settled");
    assert.equal(settled.status, "done");
    assert.equal(settled.requestDigest, requestDigest);
    assert.equal(await readFile(join(cwd, "result.txt"), "utf8"), "two");
    assert.equal(await readFile(join(cwd, "command-effects.txt"), "utf8"), "verified\n");
    const changed = { ...draft, message: "Different input must not adopt this receipt" };
    changed.requestPayload = JSON.stringify({ message: changed.message, outputSchema });
    changed.requestDigest = createHash("sha256").update(changed.requestPayload).digest("hex");
    assert.equal((await replacement.call({ id: "mismatch", ...changed })).success, false);
    const duplicate = await replacement.call({ id: "repeat-exact", ...draft });
    assert.equal(duplicate.success, true);
    assert.equal(duplicate.data.submissionId, settled.submissionId);
    const stable = await replacement.call({
      id: "stable",
      type: "status",
      requestId: draft.requestId,
    });
    assert.equal(stable.data.modelCalls, 4);
    assert.equal(
      (
        await replacement.call({
          id: "wrong-digest",
          type: "status",
          requestId: draft.requestId,
          requestDigest: "0".repeat(64),
        })
      ).success,
      false,
    );
    replacement.child.stdin.write("\n\r\n");
    const afterBlank = await replacement.call({
      id: "blank-boundary",
      type: "status",
      requestId: draft.requestId,
      requestDigest,
    });
    assert.equal(afterBlank.success, true);
    assert.equal(afterBlank.data.requestDigest, requestDigest);
    assert.equal(await readFile(join(cwd, "command-effects.txt"), "utf8"), "verified\n");
    await writeFile(
      join(scratch, "admission-evidence.json"),
      JSON.stringify(
        {
          fixture: true,
          phase,
          requestId: draft.requestId,
          requestDigest,
          originalRecords: first.records,
          statusBeforeRecovery: status.data,
          accepted: admitted.data,
          settled,
          commandEffects: 1,
        },
        null,
        2,
      ),
    );
    await replacement.close();
    t.diagnostic(`Retained real Pi/SQLite admission evidence: ${scratch}`);
  });
}

test("legacy submission without the managed digest ledger is inspectable but cannot be rebound", {
  timeout: 15000,
}, async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-legacy-admission-"));
  const cwd = join(scratch, "workspace");
  const storage = join(scratch, "storage");
  await mkdir(cwd);
  const initializer = client(cwd, storage);
  t.after(() => initializer.child.kill("SIGKILL"));
  await initializer.wait((record) => record.type === "ready");
  await initializer.close();
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const context = BACKGROUND_CONTEXT;
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(storage, "session.sqlite")),
    { models, registry: createRegistry() },
    context,
  );
  let legacyId;
  try {
    const root = await harness.root(context);
    legacyId = await root.commit(
      (tx) =>
        root.submit(tx, {
          type: "input",
          requestId: "legacy-unknown",
          content: "Legacy admitted input",
        }),
      context,
    );
  } finally {
    await harness.close(context);
  }
  const replacement = client(cwd, storage);
  t.after(() => replacement.child.kill("SIGKILL"));
  await replacement.wait((record) => record.type === "ready");
  const found = await replacement.call({
    id: "inspect-legacy",
    type: "status",
    requestId: "legacy-unknown",
  });
  assert.equal(found.data.found, true);
  assert.equal(found.data.submissionId, legacyId);
  assert.equal(found.data.requestDigest, null);
  const rebound = await replacement.call({
    id: "adopt-legacy",
    type: "submit",
    requestId: "legacy-unknown",
    message: "Legacy admitted input",
  });
  assert.equal(rebound.success, false);
  const stable = await replacement.call({
    id: "legacy-stable",
    type: "status",
    requestId: "legacy-unknown",
  });
  assert.equal(stable.data.requestDigest, null);
  assert.equal(stable.data.modelCalls, 0);
  await replacement.close();
});

test("stored authentication identity defaults only absent legacy fields and rejects explicit invalid values", {
  timeout: 15000,
}, async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-auth-identity-"));
  const cwd = join(scratch, "workspace");
  const storage = join(scratch, "storage");
  await mkdir(cwd);
  const original = client(cwd, storage);
  t.after(() => original.child.kill("SIGKILL"));
  await original.wait((record) => record.type === "ready");
  await original.close();
  const path = join(storage, "worker-identity.json");
  const identity = JSON.parse(await readFile(path, "utf8"));
  delete identity.authMode;
  delete identity.authPath;
  await writeFile(path, JSON.stringify(identity));
  const legacy = client(cwd, storage);
  t.after(() => legacy.child.kill("SIGKILL"));
  const ready = await legacy.wait((record) => record.type === "ready");
  assert.equal(ready.authMode, "apiKey");
  assert.equal(ready.authPath, null);
  await legacy.close();
  for (const invalid of [
    { authMode: null, authPath: null },
    { authMode: 42, authPath: null },
    { authMode: "", authPath: null },
    { authMode: "apiKey", authPath: 42 },
    { authMode: "apiKey", authPath: false },
  ]) {
    const bytes = JSON.stringify({ ...identity, ...invalid });
    await writeFile(path, bytes);
    const rejected = client(cwd, storage);
    t.after(() => rejected.child.kill("SIGKILL"));
    await rejected.wait((record) => record.type === "startup_error");
    assert.deepEqual(await rejected.exited, { code: 2, signal: null });
    assert.ok(!rejected.records.some((record) => record.type === "ready"));
    assert.equal(await readFile(path, "utf8"), bytes);
  }
});

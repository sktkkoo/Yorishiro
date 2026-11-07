import assert from "node:assert/strict";
import { mkdtemp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { assertAdmission, openAdmissionEpoch } from "./admission-identity.mjs";

test("admission epoch is transactional, survives Pi schema migration and changes with database identity", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-admission-identity-"));
  const path = join(scratch, "session.sqlite");
  const epoch = openAdmissionEpoch(path);
  assert.match(epoch, /^[0-9a-f-]{36}$/);
  assert.equal(openAdmissionEpoch(path), epoch);
  let storage = await openNodeSqliteStorage(path);
  assert.equal(await storage.submissionByRequest(1, "missing", BACKGROUND_CONTEXT), undefined);
  await storage.close(BACKGROUND_CONTEXT);
  assert.equal(openAdmissionEpoch(path), epoch);
  storage = await openNodeSqliteStorage(path);
  await storage.close(BACKGROUND_CONTEXT);
  await rename(path, join(scratch, "previous.sqlite"));
  const replacement = openAdmissionEpoch(path);
  assert.notEqual(replacement, epoch);
  assert.equal(openAdmissionEpoch(join(scratch, "previous.sqlite")), epoch);
  assert.equal(openAdmissionEpoch(path), replacement);
});

test("an existing Pi database can adopt the independent identity table without migration damage", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-admission-migration-"));
  const path = join(scratch, "session.sqlite");
  const original = await openNodeSqliteStorage(path);
  await original.close(BACKGROUND_CONTEXT);
  const epoch = openAdmissionEpoch(path);
  const reopened = await openNodeSqliteStorage(path);
  assert.equal(await reopened.submissionByRequest(1, "missing", BACKGROUND_CONTEXT), undefined);
  await reopened.close(BACKGROUND_CONTEXT);
  assert.equal(openAdmissionEpoch(path), epoch);
  const database = new DatabaseSync(path);
  database.prepare("UPDATE yorishiro_admission_identity_v1 SET epoch = ?").run("PRIVATE_SENTINEL");
  database.close();
  assert.throws(() => openAdmissionEpoch(path), /^Error: admission_identity_invalid$/);
});

test("admission requires the exact version, database epoch and root identity", () => {
  const expected = { version: 1, epoch: "e6b9412c-9170-448e-b54d-1af7db88d2ae", rootId: 1 };
  assert.doesNotThrow(() =>
    assertAdmission({ rootId: 1, epoch: expected.epoch, version: 1 }, expected),
  );
  for (const candidate of [
    null,
    [],
    {},
    { ...expected, version: 2 },
    { ...expected, epoch: "previous-epoch" },
    { ...expected, rootId: 2 },
    { ...expected, rootId: "1" },
    { ...expected, extra: "PRIVATE_SENTINEL" },
  ]) {
    assert.throws(() => assertAdmission(candidate, expected), /^Error: admission_mismatch$/);
  }
});

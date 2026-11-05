import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Called only while the worker owns its session lock. The epoch belongs to
 * this database, rather than to a sidecar that could survive database replacement.
 * This covers process restarts, not restoration of an earlier database snapshot. */
export function openAdmissionEpoch(path) {
  let database;
  try {
    database = new DatabaseSync(path);
    database.exec("BEGIN IMMEDIATE");
    database.exec(`CREATE TABLE IF NOT EXISTS yorishiro_admission_identity_v1 (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      epoch TEXT NOT NULL
    ) STRICT`);
    let rows = database
      .prepare("SELECT singleton, epoch FROM yorishiro_admission_identity_v1")
      .all();
    if (rows.length === 0) {
      database
        .prepare("INSERT INTO yorishiro_admission_identity_v1 (singleton, epoch) VALUES (1, ?)")
        .run(randomUUID());
      rows = database.prepare("SELECT singleton, epoch FROM yorishiro_admission_identity_v1").all();
    }
    if (
      rows.length !== 1 ||
      rows[0].singleton !== 1 ||
      typeof rows[0].epoch !== "string" ||
      !UUID.test(rows[0].epoch)
    ) {
      throw new Error();
    }
    const epoch = rows[0].epoch;
    database.exec("COMMIT");
    return epoch;
  } catch {
    try {
      database?.exec("ROLLBACK");
    } catch {
      // Retain only a fixed startup category, never database contents or paths.
    }
    throw new Error("admission_identity_invalid");
  } finally {
    database?.close();
  }
}

export function assertAdmission(value, expected) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    !Object.keys(value).every((key) => ["version", "epoch", "rootId"].includes(key)) ||
    value.version !== 1 ||
    value.epoch !== expected.epoch ||
    value.rootId !== expected.rootId
  ) {
    throw new Error("admission_mismatch");
  }
}

import { DatabaseSync } from "node:sqlite";

// Cooperative host lock in a separate database: never hold a transaction on
// Pi's session database. Keep this connection alive for the entire harness life.
export function acquireOwnerLock(path) {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA busy_timeout = 0");
    database.exec("PRAGMA journal_mode = DELETE");
    database.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    database.close();
    if (error.errcode === 5 || error.errcode === 6) {
      const owned = new Error("Storage already has a live sidecar owner");
      owned.code = "storage_owned";
      throw owned;
    }
    throw error;
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        database.exec("ROLLBACK");
      } finally {
        database.close();
      }
    },
  };
}

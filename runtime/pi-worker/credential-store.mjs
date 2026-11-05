import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const queues = new Map();
function privateFile(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new Error("private_file_required");
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
function readJson(path) {
  if (!privateFile(path)) return undefined;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    try {
      return JSON.parse(readFileSync(fd, "utf8"));
    } catch {
      throw new Error("private_json_invalid");
    }
  } finally {
    closeSync(fd);
  }
}
function atomicJson(path, value) {
  privateFile(path);
  const temporary = join(dirname(path), `.pi-auth-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    const directory = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      /* Best-effort removal of a private temporary on write failure. */
    }
  }
}

/** Pi's CredentialStore, using the same JSON schema as its own auth.json.
 * The lock is per operation, not per idle worker; refresh's async callback and
 * its resulting atomic write are one locked unit. All cooperating users must
 * use the same provider-owner.sqlite in this private directory.
 */
// Read-only readiness snapshot: atomic auth replacement yields old or new
// metadata without a lock database, token refresh, or any directory creation.
export function credentialMetadata(authPath) {
  const path = resolve(authPath);
  if (path.split(/[\\/]/).some((part) => [".codex", ".claude"].includes(part)))
    throw new Error("cli_auth_forbidden");
  const directoryPath = dirname(path);
  let directory;
  try {
    directory = lstatSync(directoryPath);
  } catch (error) {
    if (error.code === "ENOENT") return { present: false, type: null };
    throw error;
  }
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0)
    throw new Error("private_directory_required");
  const canonical = realpathSync(directoryPath);
  if (canonical.split(/[\\/]/).some((part) => [".codex", ".claude"].includes(part)))
    throw new Error("cli_auth_forbidden");
  const data = readJson(join(canonical, basename(path)));
  if (data === undefined) return { present: false, type: null };
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("auth_store_invalid");
  const type = data.openai?.type;
  if (type !== undefined && !["oauth", "api_key"].includes(type))
    throw new Error("auth_metadata_invalid");
  return { present: type !== undefined, type: type ?? null };
}

export class PiCredentialStore {
  #path;
  #directory;
  #database;
  #closed = false;
  #pending = new Set();
  #timeout;
  constructor(authPath, { lockTimeoutMs = 10_000 } = {}) {
    if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1)
      throw new Error("lock_timeout_invalid");
    const path = resolve(authPath);
    this.#directory = dirname(path);
    if (path.split(/[\\/]/).some((part) => [".codex", ".claude"].includes(part)))
      throw new Error("cli_auth_forbidden");
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const directory = lstatSync(this.#directory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0)
      throw new Error("private_directory_required");
    this.#directory = realpathSync(this.#directory);
    if (this.#directory.split(/[\\/]/).some((part) => [".codex", ".claude"].includes(part)))
      throw new Error("cli_auth_forbidden");
    this.#path = join(this.#directory, basename(path));
    this.#timeout = lockTimeoutMs;
    const lockPath = join(this.#directory, "provider-owner.sqlite");
    privateFile(lockPath);
    this.#database = new DatabaseSync(lockPath);
    chmodSync(lockPath, 0o600);
    // Do not issue journal-mode changes while another process holds the lock.
    // Fresh lock databases default to DELETE; BEGIN EXCLUSIVE is a single writer
    // even if an existing cooperating store uses WAL.
    this.#database.exec("PRAGMA busy_timeout=0");
  }
  get directory() {
    return this.#directory;
  }
  async #acquire(signal) {
    const deadline = performance.now() + this.#timeout;
    while (true) {
      signal?.throwIfAborted();
      try {
        this.#database.exec("BEGIN EXCLUSIVE");
        return;
      } catch (error) {
        if (![5, 6].includes(error.errcode)) throw new Error("auth_lock_unavailable");
        if (performance.now() >= deadline) throw new Error("auth_lock_timeout");
        await delay(Math.min(20, Math.max(1, deadline - performance.now())), undefined, { signal });
      }
    }
  }
  #operation(fn, options = {}) {
    if (this.#closed) return Promise.reject(new Error("auth_store_closed"));
    const key = this.#directory;
    const previous = queues.get(key) ?? Promise.resolve();
    const result = previous
      .catch(() => {})
      .then(async () => {
        await this.#acquire(options.signal);
        try {
          options.signal?.throwIfAborted();
          return await fn();
        } finally {
          this.#database.exec("ROLLBACK");
        }
      });
    const tail = result.catch(() => {});
    queues.set(key, tail);
    this.#pending.add(tail);
    void tail.then(() => {
      this.#pending.delete(tail);
      if (queues.get(key) === tail) queues.delete(key);
    });
    return result;
  }
  #data() {
    const value = readJson(this.#path) ?? {};
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("auth_store_invalid");
    return Object.assign(Object.create(null), value);
  }
  read(providerId, options) {
    return this.#operation(() => this.#data()[providerId], options);
  }
  list(options) {
    return this.#operation(
      () =>
        Object.entries(this.#data()).map(([providerId, credential]) => {
          if (!credential || !["oauth", "api_key"].includes(credential.type))
            throw new Error("auth_metadata_invalid");
          return { providerId, type: credential.type };
        }),
      options,
    );
  }
  modify(providerId, fn, options) {
    return this.#operation(async () => {
      const data = this.#data();
      const next = await fn(data[providerId]);
      // Once a refresh has returned rotated credentials, persist them even if
      // cancellation raced its completion; otherwise the valid refresh is lost.
      if (next !== undefined) {
        data[providerId] = next;
        atomicJson(this.#path, data);
      }
      return next ?? data[providerId];
    }, options);
  }
  delete(providerId, options) {
    return this.#operation(() => {
      const data = this.#data();
      delete data[providerId];
      atomicJson(this.#path, data);
    }, options);
  }
  async deviceId(options) {
    return this.#operation(() => {
      const path = join(this.#directory, "installation.json");
      const prior = readJson(path);
      if (prior) {
        if (
          typeof prior.deviceId !== "string" ||
          !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(prior.deviceId)
        )
          throw new Error("installation_invalid");
        return prior.deviceId;
      }
      const deviceId = randomUUID();
      atomicJson(path, { deviceId });
      return deviceId;
    }, options);
  }
  async close() {
    this.#closed = true;
    await Promise.all([...this.#pending]);
    if (this.#database) {
      this.#database.close();
      this.#database = undefined;
    }
  }
}

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
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

function privateFile(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error("Expected a private regular file");
    }
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
      throw new Error("Could not parse private Pi state");
    }
  } finally {
    closeSync(fd);
  }
}

function atomicJson(path, value) {
  // The cooperating owner lock covers the full read-modify-write operation.
  privateFile(path);
  const temporary = join(dirname(path), `.pi-auth-${randomUUID()}.tmp`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), constants.O_RDONLY);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export class PiCredentialStore {
  #path;
  #directory;
  #owner;
  #queue = Promise.resolve();
  #closed = false;

  constructor(authPath) {
    this.#path = resolve(authPath);
    if (
      this.#path.split(/[\\/]/).includes(".codex") ||
      this.#path.split(/[\\/]/).includes(".claude")
    ) {
      throw new Error("CLI credential locations are not supported");
    }
    this.#directory = dirname(this.#path);
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const directory = lstatSync(this.#directory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) {
      throw new Error("Credential directory must be private (0700) and not a symlink");
    }
    const resolvedParts = realpathSync(this.#directory).split(/[\\/]/);
    if (resolvedParts.includes(".codex") || resolvedParts.includes(".claude")) {
      throw new Error("CLI credential locations are not supported");
    }
    const ownerPath = join(this.#directory, "provider-owner.sqlite");
    privateFile(ownerPath);
    const owner = new DatabaseSync(ownerPath);
    try {
      chmodSync(ownerPath, 0o600);
      owner.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
      this.#owner = owner;
    } catch (error) {
      owner.close();
      if (error.errcode === 5 || error.errcode === 6)
        throw new Error("Another Pi provider driver owns this directory");
      throw error;
    }
  }

  #enqueue(operation, options) {
    if (this.#closed) return Promise.reject(new Error("Credential store is closed"));
    const result = this.#queue.then(() => {
      options?.signal?.throwIfAborted();
      return operation();
    });
    this.#queue = result.catch(() => {});
    return result;
  }

  #data() {
    const value = readJson(this.#path) ?? {};
    if (typeof value !== "object" || Array.isArray(value) || value === null)
      throw new Error("Invalid Pi credential store");
    return value;
  }

  read(providerId, options) {
    return this.#enqueue(() => this.#data()[providerId], options);
  }
  list(options) {
    return this.#enqueue(
      () =>
        Object.entries(this.#data()).map(([providerId, credential]) => {
          if (!credential || !["api_key", "oauth"].includes(credential.type))
            throw new Error("Invalid Pi credential metadata");
          return { providerId, type: credential.type };
        }),
      options,
    );
  }
  modify(providerId, fn, options) {
    return this.#enqueue(async () => {
      const data = this.#data();
      const next = await fn(data[providerId]);
      options?.signal?.throwIfAborted();
      if (next !== undefined) {
        data[providerId] = next;
        atomicJson(this.#path, data);
      }
      return next ?? data[providerId];
    }, options);
  }
  delete(providerId, options) {
    return this.#enqueue(() => {
      const data = this.#data();
      delete data[providerId];
      atomicJson(this.#path, data);
    }, options);
  }
  deviceId() {
    if (this.#closed) throw new Error("Credential store is closed");
    const path = join(this.#directory, "installation.json");
    const prior = readJson(path);
    if (prior) {
      if (
        typeof prior.deviceId !== "string" ||
        !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(prior.deviceId)
      ) {
        throw new Error("Invalid installation UUID");
      }
      return prior.deviceId;
    }
    const deviceId = randomUUID();
    atomicJson(path, { deviceId });
    return deviceId;
  }
  async close() {
    this.#closed = true;
    await this.#queue;
    if (this.#owner) {
      try {
        this.#owner.exec("ROLLBACK");
      } finally {
        this.#owner.close();
        this.#owner = null;
      }
    }
  }
}

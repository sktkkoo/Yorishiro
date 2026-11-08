import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export const COMMAND_OUTPUT_LIMITS = Object.freeze({
  maxLogBytes: 16 * 1024 * 1024,
  maxSessionBytes: 64 * 1024 * 1024,
  maxLogs: 20,
  maxReadBytes: 64 * 1024,
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const unavailable = () => new Error("command_output_unavailable");
const privateMode = (stat) => process.platform === "win32" || (stat.mode & 0o077) === 0;
function owned(stat) {
  return (
    privateMode(stat) && (typeof process.getuid !== "function" || stat.uid === process.getuid())
  );
}
function privateDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat) || realpathSync(path) !== path)
    throw unavailable();
  return stat;
}
function file(path, flags) {
  const fd = openSync(
    path,
    flags | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    0o600,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !owned(stat) || stat.nlink !== 1) throw unavailable();
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
function writeAll(fd, data, position) {
  let done = 0;
  while (done < data.length) {
    const count = writeSync(fd, data, done, data.length - done, position + done);
    if (count === 0) throw unavailable();
    done += count;
  }
}

/** ログは現在のセッション内だけに保存する。同期の小分け書き込みにより、
 * 非同期キューへ無制限に出力を積み上げない。 */
export function createCommandOutputStore(sessionDir, commandIds, overrides = {}) {
  const limits = { ...COMMAND_OUTPUT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > COMMAND_OUTPUT_LIMITS[key])
      throw unavailable();
  }
  const allowed = new Set(commandIds);
  const active = new Set();
  let directory;
  let identity;
  function ready() {
    if (!sessionDir) throw unavailable();
    if (lstatSync(sessionDir).isSymbolicLink()) throw unavailable();
    const session = realpathSync(sessionDir);
    privateDirectory(session);
    const selected = join(session, "command-logs");
    try {
      mkdirSync(selected, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = privateDirectory(selected);
    if (
      directory &&
      (directory !== selected || identity.ino !== stat.ino || identity.dev !== stat.dev)
    )
      throw unavailable();
    directory = selected;
    identity = stat;
    return directory;
  }
  function prune() {
    const rows = new Map();
    const dir = opendirSync(ready());
    let count = 0;
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (++count > 1024) throw unavailable();
        const match = /^(.+)\.(log|json)$/.exec(entry.name);
        if (!match || !uuid.test(match[1])) throw unavailable();
        const stat = lstatSync(join(directory, entry.name));
        if (!stat.isFile() || !owned(stat) || stat.nlink !== 1) throw unavailable();
        const row = rows.get(match[1]) ?? {
          id: match[1],
          bytes: 0,
          mtime: stat.mtimeMs,
          files: [],
        };
        row.bytes += stat.size;
        row.mtime = Math.min(row.mtime, stat.mtimeMs);
        row.files.push(entry.name);
        rows.set(row.id, row);
      }
    } finally {
      dir.closeSync();
    }
    let bytes = [...rows.values()].reduce(
      (sum, row) => sum + (active.has(row.id) ? limits.maxLogBytes + 4096 : row.bytes),
      0,
    );
    let size = rows.size;
    // 新しいログと小さなメタデータの分も、開始時に確保する。
    for (const row of [...rows.values()].sort((a, b) => a.mtime - b.mtime)) {
      if (size < limits.maxLogs && bytes + limits.maxLogBytes + 4096 <= limits.maxSessionBytes)
        break;
      if (active.has(row.id)) continue;
      ready();
      for (const name of row.files) unlinkSync(join(directory, name));
      size -= 1;
      bytes -= row.bytes;
    }
    if (size >= limits.maxLogs || bytes + limits.maxLogBytes + 4096 > limits.maxSessionBytes)
      throw unavailable();
  }
  return {
    start(commandId) {
      if (!allowed.has(commandId)) throw unavailable();
      prune();
      const logId = randomUUID();
      const path = join(directory, `${logId}.log`);
      const fd = file(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      active.add(logId);
      let storedBytes = 0;
      let failed = false;
      return {
        append(chunk) {
          if (failed) return;
          try {
            const bytes = Math.min(chunk.length, limits.maxLogBytes - storedBytes);
            if (bytes > 0) {
              writeAll(fd, chunk.subarray(0, bytes), storedBytes);
              storedBytes += bytes;
            }
          } catch {
            failed = true;
          }
        },
        finish(details, tail) {
          let tailBytes = 0;
          try {
            ready();
            if (failed) throw unavailable();
            if (details.outputBytes > storedBytes) {
              tailBytes = Math.min(tail.length, storedBytes);
              writeAll(fd, tail.subarray(tail.length - tailBytes), storedBytes - tailBytes);
            }
            const metadata = {
              version: 1,
              logId,
              commandId,
              ...details,
              storedBytes,
              logTruncated: details.outputBytes > storedBytes,
              prefixBytes: storedBytes - tailBytes,
              tailBytes,
            };
            const meta = file(
              join(directory, `${logId}.json`),
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
            );
            try {
              writeAll(meta, Buffer.from(JSON.stringify(metadata)), 0);
            } finally {
              closeSync(meta);
            }
            return { logId, logTruncated: metadata.logTruncated, logUnavailable: false };
          } catch {
            return { logId: null, logTruncated: true, logUnavailable: true };
          } finally {
            try {
              closeSync(fd);
            } catch {
              /* 終了コードの報告はログ障害で失わない。 */
            }
            active.delete(logId);
          }
        },
      };
    },
    read(args) {
      let fd;
      let meta;
      const alreadyActive = active.has(args?.logId);
      try {
        if (
          !args ||
          Object.keys(args).some((key) => !["logId", "offset", "tail"].includes(key)) ||
          !uuid.test(args.logId) ||
          (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0)) ||
          (args.tail !== undefined && typeof args.tail !== "boolean") ||
          (args.tail && args.offset !== undefined)
        )
          throw unavailable();
        ready();
        active.add(args.logId);
        meta = file(join(directory, `${args.logId}.json`), constants.O_RDONLY);
        if (fstatSync(meta).size > 4096) throw unavailable();
        const buffer = Buffer.alloc(4097);
        const length = readSync(meta, buffer, 0, buffer.length, 0);
        const info = JSON.parse(buffer.subarray(0, length).toString("utf8"));
        if (
          info.version !== 1 ||
          info.logId !== args.logId ||
          !allowed.has(info.commandId) ||
          (info.exitCode !== null &&
            (!Number.isInteger(info.exitCode) || info.exitCode < 0 || info.exitCode > 255)) ||
          (info.signal !== null &&
            (typeof info.signal !== "string" || !/^SIG[A-Z0-9]{1,24}$/.test(info.signal))) ||
          typeof info.completedSuccessfully !== "boolean" ||
          (info.completedSuccessfully && (info.exitCode !== 0 || info.signal !== null)) ||
          !Number.isSafeInteger(info.storedBytes) ||
          info.storedBytes < 0 ||
          info.storedBytes > limits.maxLogBytes ||
          !Number.isSafeInteger(info.outputBytes) ||
          info.outputBytes < info.storedBytes ||
          !Number.isSafeInteger(info.prefixBytes) ||
          info.prefixBytes < 0 ||
          !Number.isSafeInteger(info.tailBytes) ||
          info.tailBytes < 0 ||
          info.prefixBytes + info.tailBytes !== info.storedBytes ||
          typeof info.logTruncated !== "boolean" ||
          info.logTruncated !== info.outputBytes > info.storedBytes
        )
          throw unavailable();
        fd = file(join(directory, `${args.logId}.log`), constants.O_RDONLY);
        if (fstatSync(fd).size !== info.storedBytes) throw unavailable();
        const offset = args.tail
          ? Math.max(0, info.storedBytes - limits.maxReadBytes)
          : (args.offset ?? 0);
        if (offset > info.storedBytes) throw unavailable();
        const content = Buffer.alloc(Math.min(limits.maxReadBytes, info.storedBytes - offset));
        const bytes = readSync(fd, content, 0, content.length, offset);
        return {
          content: content.subarray(0, bytes).toString("utf8"),
          logId: info.logId,
          commandId: info.commandId,
          exitCode: info.exitCode,
          signal: info.signal,
          completedSuccessfully: info.completedSuccessfully,
          offset,
          nextOffset: offset + bytes,
          storedBytes: info.storedBytes,
          outputBytes: info.outputBytes,
          logTruncated: info.logTruncated,
          prefixBytes: info.prefixBytes,
          tailBytes: info.tailBytes,
          note: info.logTruncated
            ? "Stored prefix and final tail have an omitted middle. Offsets refer to stored bytes, not continuous original output."
            : "Offsets refer to stored output bytes.",
        };
      } catch {
        throw unavailable();
      } finally {
        if (fd !== undefined) closeSync(fd);
        if (meta !== undefined) closeSync(meta);
        if (args?.logId && !alreadyActive) active.delete(args.logId);
      }
    },
  };
}

export function createCommandOutput(maxBytes, commandId, store) {
  const headLimit = Math.ceil(maxBytes / 2);
  const tailLimit = Math.floor(maxBytes / 2);
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let outputBytes = 0;
  let log;
  let logUnavailable = false;
  try {
    log = store?.start(commandId);
  } catch {
    logUnavailable = true;
  }
  return {
    append(chunk) {
      outputBytes += chunk.length;
      const headBytes = Math.min(chunk.length, headLimit - head.length);
      if (headBytes > 0) head = Buffer.concat([head, chunk.subarray(0, headBytes)]);
      if (tailLimit) tail = Buffer.concat([tail, chunk]).subarray(-tailLimit);
      log?.append(chunk);
    },
    finish(exitCode, signal, hostFailed = false) {
      const truncated = outputBytes > maxBytes;
      const details = {
        commandId,
        exitCode,
        signal: signal ?? null,
        completedSuccessfully: exitCode === 0 && !signal && !hostFailed,
        outputBytes,
        truncated,
      };
      let logging = { logId: null, logTruncated: false, logUnavailable };
      try {
        if (log) logging = log.finish(details, tail);
      } catch {
        logging = { logId: null, logTruncated: true, logUnavailable: true };
      }
      const content = truncated
        ? `${head.toString("utf8")}\n[... command output omitted ...]\n${tail.toString("utf8")}`
        : Buffer.concat([
            head,
            tail.subarray(Math.max(0, head.length + tail.length - outputBytes)),
          ]).toString("utf8");
      return { content, details: { ...details, ...logging } };
    },
  };
}

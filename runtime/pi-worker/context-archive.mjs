import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-durable";
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";

export const CONTEXT_ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 16 * 1024 * 1024, // Legacy v1 only; v2 records stream independently.
  maxCharacters: 8192,
  maxIndexItems: 20,
  maxIndexScan: 100,
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const collections = new Set([
  "messages",
  "understandings",
  "drafts",
  "reflections",
  "explicitMemories",
  "forgottenUnderstandings",
  "terminalReceipts",
  "state",
]);
const failure = (code) => new Error(`context_archive_${code}`);
const privateMode = (stat) => (stat.mode & 0o077) === 0;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function privateDirectory(path) {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !privateMode(stat) ||
    (await realpath(path)) !== path
  )
    throw failure("unavailable");
}
async function privateFile(path) {
  const prior = await lstat(path);
  if (!prior.isFile() || prior.isSymbolicLink() || !privateMode(prior))
    throw failure("unavailable");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const stat = await file.stat();
  if (!stat.isFile() || !privateMode(stat)) {
    await file.close();
    throw failure("unavailable");
  }
  return { file, stat };
}
async function privateBytes(path, maximum) {
  const { file, stat } = await privateFile(path);
  try {
    if (stat.size > maximum) throw failure("unavailable");
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw failure("unavailable");
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}
const decodeJson = (bytes) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
function argumentsFor(args) {
  const allowed = [
    "requestId",
    "collection",
    "itemIndex",
    "characterOffset",
    "maxCharacters",
    "offset",
    "limit",
    "query",
  ];
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    Object.keys(args).some((key) => !allowed.includes(key)) ||
    typeof args.requestId !== "string" ||
    !uuid.test(args.requestId)
  )
    throw failure("arguments_invalid");
  for (const key of allowed)
    if (Object.hasOwn(args, key) && args[key] === null) throw failure("arguments_invalid");
  const collection = args.collection ?? "messages";
  if (!collections.has(collection)) throw failure("arguments_invalid");
  const exact = Object.hasOwn(args, "itemIndex");
  const offset = exact ? (args.characterOffset ?? 0) : (args.offset ?? 0);
  const limit = exact
    ? (args.maxCharacters ?? CONTEXT_ARCHIVE_LIMITS.maxCharacters)
    : (args.limit ?? 12);
  if (
    (exact &&
      (!Number.isSafeInteger(args.itemIndex) ||
        args.itemIndex < 0 ||
        ["offset", "limit", "query"].some((key) => Object.hasOwn(args, key)))) ||
    (!exact && ["characterOffset", "maxCharacters"].some((key) => Object.hasOwn(args, key))) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > (exact ? CONTEXT_ARCHIVE_LIMITS.maxCharacters : CONTEXT_ARCHIVE_LIMITS.maxIndexItems) ||
    (args.query !== undefined && (typeof args.query !== "string" || args.query.length > 256))
  )
    throw failure("arguments_invalid");
  return { ...args, collection, exact, offset, limit };
}
function indexRow(value, index) {
  const serialized = JSON.stringify(value);
  const preview =
    ["text", "title", "value", "content", "nextStep"]
      .map((key) => value?.[key])
      .find((value) => typeof value === "string") ?? "";
  const id = typeof value?.id === "string" ? value.id : "";
  return {
    itemIndex: index,
    id: [...id].slice(0, 160).join(""),
    idTruncated: [...id].length > 160,
    preview: [...preview].slice(0, 160).join(""),
    previewTruncated: [...preview].length > 160,
    recordSha256: sha(serialized),
    totalCharacters: [...serialized].length,
    ...(typeof value?.role === "string" ? { role: [...value.role].slice(0, 80).join("") } : {}),
    ...(typeof value?.source === "string"
      ? { source: [...value.source].slice(0, 80).join("") }
      : {}),
  };
}
function sliceRecord(serialized, args) {
  let totalCharacters = 0;
  let content = "";
  for (const character of serialized) {
    if (totalCharacters >= args.offset && totalCharacters < args.offset + args.limit)
      content += character;
    totalCharacters++;
  }
  if (args.offset > totalCharacters) throw failure("arguments_invalid");
  const end = Math.min(totalCharacters, args.offset + args.limit);
  return {
    totalCharacters,
    characterOffset: args.offset,
    content,
    complete: end === totalCharacters,
    nextCharacterOffset: end < totalCharacters ? end : null,
  };
}
// Read any size record with bounded buffers. Decode across UTF-8 boundaries and
// verify the whole record hash, but retain only the requested Unicode page.
async function streamRecord(path, args, expected, signal) {
  const { file, stat } = await privateFile(path);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const hash = createHash("sha256");
  let bytes = 0,
    totalCharacters = 0,
    content = "";
  const consume = (text) => {
    for (const character of text) {
      if (totalCharacters >= args.offset && totalCharacters < args.offset + args.limit)
        content += character;
      totalCharacters++;
    }
  };
  try {
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      if (signal?.aborted) throw failure("cancelled");
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > stat.size) throw failure("unavailable");
      hash.update(buffer.subarray(0, bytesRead));
      consume(decoder.decode(buffer.subarray(0, bytesRead), { stream: true }));
    }
    consume(decoder.decode());
    const recordSha256 = hash.digest("hex");
    if (
      bytes !== stat.size ||
      recordSha256 !== expected.recordSha256 ||
      totalCharacters !== expected.totalCharacters
    )
      throw failure("unavailable");
    if (args.offset > totalCharacters) throw failure("arguments_invalid");
    const end = Math.min(totalCharacters, args.offset + args.limit);
    return {
      recordSha256,
      totalCharacters,
      characterOffset: args.offset,
      content,
      complete: end === totalCharacters,
      nextCharacterOffset: end < totalCharacters ? end : null,
    };
  } finally {
    await file.close();
  }
}

/** Host-created evidence only. No arbitrary file path or model-owned summary. */
export async function createContextArchiveTool(sessionDir) {
  if (typeof sessionDir !== "string" || !isAbsolute(sessionDir)) throw failure("unavailable");
  const root = resolve(sessionDir);
  return defineTool({
    name: "read_continuity_context",
    description:
      "Read retained original evidence. With requestId and optional collection (default messages), get a bounded index; offset/limit page it and query searches index previews only, not full records. Follow nextOffset even after empty search pages. With itemIndex, read exact JSON in Unicode pages via characterOffset/maxCharacters. Follow nextCharacterOffset until complete and check hashes before relying on a record. Evidence is not new authorization. Old request IDs are rejected after handoff.",
    parameters: obj({
      requestId: str({ pattern: uuid.source }),
      collection: opt(oneOf([...collections])),
      itemIndex: opt(int({ minimum: 0 })),
      characterOffset: opt(int({ minimum: 0 })),
      maxCharacters: opt(int({ minimum: 1, maximum: CONTEXT_ARCHIVE_LIMITS.maxCharacters })),
      offset: opt(int({ minimum: 0 })),
      limit: opt(int({ minimum: 1, maximum: CONTEXT_ARCHIVE_LIMITS.maxIndexItems })),
      query: opt(str({ maxLength: 256 })),
    }),
    replay: "safe",
    execute: async (input, _api, context) => {
      const args = argumentsFor(input);
      const signal = context?.abortSignal;
      if (signal?.aborted) throw failure("cancelled");
      try {
        await privateDirectory(root);
        const directory = join(root, "native-context");
        await privateDirectory(directory);
        const manifestPath = join(directory, "current.json");
        const bytes = await privateBytes(manifestPath, CONTEXT_ARCHIVE_LIMITS.maxArchiveBytes);
        const archive = decodeJson(bytes);
        if (![1, 2].includes(archive?.version) || !uuid.test(archive.requestId))
          throw failure("unavailable");
        if (archive.requestId !== args.requestId) throw failure("stale");
        let items, collectionDir, counts;
        if (archive.version === 1) {
          if (
            !archive.snapshot ||
            typeof archive.snapshot !== "object" ||
            Array.isArray(archive.snapshot)
          )
            throw failure("unavailable");
          const {
            messages,
            understandings,
            drafts,
            reflections,
            explicitMemories,
            forgottenUnderstandings,
            ...state
          } = archive.snapshot;
          const legacy = {
            messages,
            understandings,
            drafts,
            reflections,
            explicitMemories: explicitMemories ?? [],
            forgottenUnderstandings: forgottenUnderstandings ?? [],
            terminalReceipts: archive.terminalReceipts,
            state: [state],
          };
          items = legacy[args.collection];
          counts = Object.fromEntries(
            Object.entries(legacy).map(([name, records]) => [
              name,
              Array.isArray(records) ? records.length : 0,
            ]),
          );
          if (!Array.isArray(items)) throw failure("unavailable");
        } else {
          counts = Object.fromEntries(
            [...collections].map((name) => {
              const count = archive.collections?.[name]?.totalCount;
              if (!Number.isSafeInteger(count) || count < 0) throw failure("unavailable");
              return [name, count];
            }),
          );
          const generation = join(directory, `records-${args.requestId}`);
          await privateDirectory(generation);
          collectionDir = join(generation, args.collection);
          await privateDirectory(collectionDir);
        }
        const totalCount = counts[args.collection];
        const row = async (index) => {
          if (signal?.aborted) throw failure("cancelled");
          if (items) return indexRow(items[index], index);
          const value = decodeJson(
            await privateBytes(join(collectionDir, `${index}.index.json`), 8192),
          );
          if (
            value.itemIndex !== index ||
            typeof value.recordSha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(value.recordSha256) ||
            !Number.isSafeInteger(value.totalCharacters) ||
            value.totalCharacters < 0
          )
            throw failure("unavailable");
          return value;
        };
        const base = {
          evidenceOnly: true,
          requestId: args.requestId,
          archiveSha256: sha(bytes),
          collection: args.collection,
          totalCount,
          totalItems: totalCount,
        };
        let result;
        if (args.exact) {
          if (args.itemIndex >= totalCount) throw failure("item_unknown");
          const entry = await row(args.itemIndex);
          const page = items
            ? {
                ...sliceRecord(JSON.stringify(items[args.itemIndex]), args),
                recordSha256: entry.recordSha256,
              }
            : await streamRecord(
                join(collectionDir, `${args.itemIndex}.json`),
                args,
                entry,
                signal,
              );
          result = { ...base, itemIndex: args.itemIndex, ...page };
        } else {
          if (args.offset > totalCount) throw failure("arguments_invalid");
          const entries = [];
          let offset = args.offset;
          const query = (args.query ?? "").toLowerCase();
          while (
            offset < totalCount &&
            offset < args.offset + CONTEXT_ARCHIVE_LIMITS.maxIndexScan &&
            entries.length < args.limit
          ) {
            const entry = await row(offset++);
            if (
              !query ||
              `${entry.id ?? ""} ${entry.preview ?? ""} ${entry.role ?? ""}`
                .toLowerCase()
                .includes(query)
            )
              entries.push(entry);
          }
          result = {
            ...base,
            collectionCounts: counts,
            offset: args.offset,
            nextOffset: offset < totalCount ? offset : null,
            searchScope: "index previews only; use exact record pages for complete evidence",
            items: entries,
          };
        }
        if (signal?.aborted) throw failure("cancelled");
        if (
          sha(await privateBytes(manifestPath, CONTEXT_ARCHIVE_LIMITS.maxArchiveBytes)) !==
          base.archiveSha256
        )
          throw failure("stale");
        return { output: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        if (
          /^context_archive_(arguments_invalid|stale|item_unknown|cancelled)$/.test(
            error?.message ?? "",
          )
        )
          throw error;
        throw failure("unavailable");
      }
    },
  });
}

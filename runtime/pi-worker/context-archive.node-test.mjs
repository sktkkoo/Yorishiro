import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONTEXT_ARCHIVE_LIMITS, createContextArchiveTool } from "./context-archive.mjs";

const requestId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const args = (extra = {}) => ({ requestId, collection: "messages", itemIndex: 0, ...extra });
async function fixture(value = { id: "message-1", text: "元の記録😀" }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "yorishiro-context-archive-")));
  await chmod(root, 0o700);
  const directory = join(root, "native-context");
  await mkdir(directory, { mode: 0o700 });
  const path = join(directory, "current.json");
  const document = {
    version: 1,
    requestId,
    snapshot: { messages: [value], understandings: [], drafts: [], reflections: [] },
    terminalReceipts: [{ requestId: "old-request", evidence: [] }],
  };
  await writeFile(path, JSON.stringify(document), { mode: 0o600 });
  const tool = await createContextArchiveTool(root);
  const call = async (input, signal) =>
    JSON.parse((await tool.execute(input, {}, { abortSignal: signal })).output[0].text);
  return { root, directory, path, document, call, tool };
}

test("archive returns exact original evidence and hash without modifying storage", async () => {
  const f = await fixture();
  const before = await readFile(f.path);
  const result = await f.call(args());
  assert.equal(result.evidenceOnly, true);
  assert.deepEqual(JSON.parse(result.content), f.document.snapshot.messages[0]);
  assert.equal(result.archiveSha256, createHash("sha256").update(before).digest("hex"));
  assert.equal(result.complete, true);
  assert.equal(result.nextCharacterOffset, null);
  assert.deepEqual(await readFile(f.path), before);
  assert.deepEqual(await readdir(f.directory), ["current.json"]);
  const receipt = await f.call(args({ collection: "terminalReceipts" }));
  assert.deepEqual(JSON.parse(receipt.content), f.document.terminalReceipts[0]);
});

test("Unicode chunks reconstruct a large original record without split surrogate pairs", async () => {
  const f = await fixture({ id: "large", text: '😀漢字é"\\\n'.repeat(5000) });
  let offset = 0;
  let serialized = "";
  let pages = 0;
  while (true) {
    const result = await f.call(args({ characterOffset: offset, maxCharacters: 997 }));
    serialized += result.content;
    assert.equal(Array.from(result.content).length <= 997, true);
    assert.equal(JSON.stringify(result).length < 12_000, true);
    pages += 1;
    if (result.complete) {
      assert.equal(result.nextCharacterOffset, null);
      break;
    }
    assert.ok(result.nextCharacterOffset > offset);
    offset = result.nextCharacterOffset;
  }
  assert.ok(pages > 10);
  assert.deepEqual(JSON.parse(serialized), f.document.snapshot.messages[0]);
});

test("only current archive request is readable after an atomic settled-request replacement", async () => {
  const f = await fixture();
  await assert.rejects(f.call(args({ requestId: secondId })), /context_archive_stale/);
  const next = join(f.directory, "new.json");
  await writeFile(next, JSON.stringify({ ...f.document, requestId: secondId }), { mode: 0o600 });
  await rename(next, f.path);
  await assert.rejects(f.call(args()), /context_archive_stale/);
  assert.equal((await f.call(args({ requestId: secondId }))).requestId, secondId);
});

test("invalid paths, collection, index and page arguments cannot select arbitrary files", async () => {
  const f = await fixture();
  for (const input of [
    undefined,
    null,
    {},
    args({ requestId: "../../auth.json" }),
    args({ requestId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }),
    args({ collection: "__proto__" }),
    args({ collection: "../auth" }),
    args({ itemIndex: -1 }),
    args({ itemIndex: 0.5 }),
    args({ itemIndex: NaN }),
    args({ characterOffset: -1 }),
    args({ characterOffset: null }),
    args({ maxCharacters: null }),
    args({ maxCharacters: 0 }),
    args({ maxCharacters: 8193 }),
    args({ path: "/private/credential.json" }),
  ])
    await assert.rejects(f.call(input), /context_archive_arguments_invalid/);
  await assert.rejects(f.call(args({ itemIndex: 1 })), /context_archive_item_unknown/);
  await assert.rejects(
    f.call(args({ characterOffset: 100000 })),
    /context_archive_arguments_invalid/,
  );
});

test("missing archive is read-only and errors omit paths or stored content", async () => {
  const f = await fixture();
  const missing = join(f.root, "does-not-exist");
  const tool = await createContextArchiveTool(missing);
  await assert.rejects(tool.execute(args(), {}, {}), { message: "context_archive_unavailable" });
  assert.deepEqual((await readdir(f.root)).sort(), ["native-context"]);
  await writeFile(f.path, "sensitive malformed archive content", { mode: 0o600 });
  await assert.rejects(f.call(args()), { message: "context_archive_unavailable" });
  await writeFile(f.path, Buffer.from([0xff, 0xfe]));
  await assert.rejects(f.call(args()), { message: "context_archive_unavailable" });
  await assert.rejects(createContextArchiveTool("relative"), /context_archive_unavailable/);
});

test("archive enforces private regular files, canonical parents, and fixed size cap", async () => {
  const f = await fixture();
  await chmod(f.path, 0o644);
  await assert.rejects(f.call(args()), /context_archive_unavailable/);
  await chmod(f.path, 0o600);
  await chmod(f.directory, 0o755);
  await assert.rejects(f.call(args()), /context_archive_unavailable/);
  await chmod(f.directory, 0o700);
  const alias = join(f.root, "alias");
  await symlink(f.root, alias);
  const aliasTool = await createContextArchiveTool(alias);
  await assert.rejects(aliasTool.execute(args(), {}, {}), /context_archive_unavailable/);
  await rename(f.path, join(f.directory, "original.json"));
  await symlink(join(f.directory, "original.json"), f.path);
  await assert.rejects(f.call(args()), /context_archive_unavailable/);
  const other = await fixture();
  const file = await import("node:fs/promises").then((fs) => fs.open(other.path, "r+"));
  try {
    await file.truncate(CONTEXT_ARCHIVE_LIMITS.maxArchiveBytes + 1);
  } finally {
    await file.close();
  }
  await assert.rejects(other.call(args()), /context_archive_unavailable/);
});

test("cancelled reads fail before accessing the archive", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.call(args(), controller.signal), /context_archive_cancelled/);
});

async function v2Fixture(records) {
  const f = await fixture();
  const names = [
    "messages",
    "understandings",
    "drafts",
    "reflections",
    "explicitMemories",
    "forgottenUnderstandings",
    "terminalReceipts",
    "state",
  ];
  const generation = join(f.directory, `records-${requestId}`);
  await mkdir(generation, { mode: 0o700 });
  const manifest = { version: 2, requestId, collections: {} };
  for (const name of names) {
    const values = records[name] ?? [];
    const dir = join(generation, name);
    await mkdir(dir, { mode: 0o700 });
    manifest.collections[name] = { totalCount: values.length };
    for (let index = 0; index < values.length; index++) {
      const value = values[index];
      const content = JSON.stringify(value);
      const preview = [...(value.text ?? value.nextStep ?? "")].slice(0, 160).join("");
      const row = {
        itemIndex: index,
        id: value.id ?? "",
        preview,
        previewTruncated: preview.length < (value.text ?? "").length,
        recordSha256: createHash("sha256").update(content).digest("hex"),
        totalCharacters: [...content].length,
      };
      await writeFile(join(dir, `${index}.json`), content, { mode: 0o600 });
      await writeFile(join(dir, `${index}.index.json`), JSON.stringify(row), { mode: 0o600 });
    }
  }
  await writeFile(f.path, JSON.stringify(manifest), { mode: 0o600 });
  return { ...f, generation };
}

test("v2 index stays bounded, searches pages, and records beyond 16 MiB remain readable", async () => {
  const huge = {
    id: "huge",
    text: `😀${"x".repeat(CONTEXT_ARCHIVE_LIMITS.maxArchiveBytes + 10)}終`,
  };
  const records = Array.from({ length: 105 }, (_, i) => ({ id: `m${i}`, text: `記録${i}` }));
  records.push(huge);
  const f = await v2Fixture({
    messages: records,
    state: [{ nextStep: "続き", pendingCorrectionIds: ["u1"] }],
  });
  const index = await f.call({ requestId });
  assert.equal(index.items.length, 12);
  assert.equal(index.nextOffset, 12);
  assert.equal(index.totalCount, 106);
  assert.ok(JSON.stringify(index).length < 10000);
  const empty = await f.call({ requestId, query: "huge" });
  assert.equal(empty.items.length, 0);
  assert.equal(empty.nextOffset, 100);
  const found = await f.call({ requestId, query: "huge", offset: empty.nextOffset });
  assert.equal(found.items[0].itemIndex, 105);
  const start = await f.call(args({ itemIndex: 105, maxCharacters: 40 }));
  assert.equal(start.content, [...JSON.stringify(huge)].slice(0, 40).join(""));
  assert.equal(start.complete, false);
  const last = await f.call(args({ itemIndex: 105, characterOffset: start.totalCharacters - 8 }));
  assert.equal(last.content, [...JSON.stringify(huge)].slice(-8).join(""));
  assert.equal(last.complete, true);
  assert.equal(last.recordSha256, found.items[0].recordSha256);
  const state = await f.call(args({ collection: "state" }));
  assert.deepEqual(JSON.parse(state.content).pendingCorrectionIds, ["u1"]);
});

test("v2 exact reads reject changed records and unsafe index files", async () => {
  const f = await v2Fixture({ messages: [{ id: "one", text: "original" }] });
  const dir = join(f.generation, "messages");
  await writeFile(join(dir, "0.json"), '{"id":"one","text":"tampered"}');
  await assert.rejects(f.call(args()), /context_archive_unavailable/);
  await chmod(join(dir, "0.index.json"), 0o644);
  await assert.rejects(f.call({ requestId }), /context_archive_unavailable/);
  await assert.rejects(f.call({ requestId, limit: 21 }), /context_archive_arguments_invalid/);
  await assert.rejects(f.call(args({ query: "ambiguous" })), /context_archive_arguments_invalid/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { describeSubmissionTools } from "./submission-evidence.mjs";

const record = { type: "input", status: "done", entry: 1, answer: 100 };
const call = (entryId, id, name, args) => ({
  id: entryId,
  kind: "pi.assistant",
  model: [{ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] }],
});
const result = (entryId, id, toolName, extra = {}) => ({
  id: entryId,
  kind: "pi.tool-result",
  model: [{ role: "toolResult", toolCallId: id, toolName, isError: false, content: [], ...extra }],
});
function rootFor(pages) {
  const queries = [];
  return {
    queries,
    async entries(query, limit, cursor) {
      queries.push({ query, limit, cursor });
      const index = cursor ?? 0;
      return { items: pages[index], ...(index + 1 < pages.length ? { next: index + 1 } : {}) };
    },
  };
}
const evidence = (pages, verified = []) =>
  describeSubmissionTools(
    rootFor(pages),
    record,
    {},
    { verifiedProjectCommandIds: new Set(verified) },
  );

test("attributes effects to original durable calls across pages, not reported details", async () => {
  const root = rootFor([
    [call(2, "read", "read_file", { path: "README.md" }), result(3, "read", "read_file")],
    [
      call(4, "write", "write_file", { path: "result.md", content: "verified result" }),
      result(5, "write", "write_file", { details: { effect: "read", progressed: false } }),
      call(6, "edit", "edit_file", { path: "result.md", oldText: "verified", newText: "checked" }),
      result(7, "edit", "edit_file"),
    ],
  ]);
  const value = await describeSubmissionTools(root, record, {});
  assert.equal(value.toolEvidenceComplete, true);
  assert.deepEqual(value.toolEvidenceRange, { firstEntryId: 1, lastEntryId: 100 });
  assert.deepEqual(
    value.toolResults.map((item) => [item.toolName, item.effect, item.callEntryId]),
    [
      ["read_file", "read", 2],
      ["write_file", "write", 4],
      ["edit_file", "write", 6],
    ],
  );
  assert.ok(value.toolResults.every((item) => item.progressEvidenceVersion === 1));
  assert.equal(root.queries.length, 2);
  assert.deepEqual(root.queries[0].query, { minEntryId: 1, maxEntryId: 100, order: "ascending" });
});

test("only host-verified fixed project commands get project-check classification", async () => {
  const entries = [];
  const commands = [
    "workspace-info",
    "validate-json",
    "git-status",
    "git-diff",
    "project-check",
    "project-test",
    "project-build",
    "custom",
  ];
  for (const [index, commandId] of commands.entries()) {
    entries.push(
      call(2 + index * 2, commandId, "run_command", { commandId }),
      result(3 + index * 2, commandId, "run_command", {
        details: { effect: "project-check", commandId: "project-test", progressed: true },
      }),
    );
  }
  const unverified = await evidence([entries]);
  assert.deepEqual(
    unverified.toolResults.map((v) => v.effect),
    ["read", "read", "read", "read", "unknown", "unknown", "unknown", "unknown"],
  );
  const verified = await evidence(
    [entries],
    ["project-check", "project-test", "project-build", "custom"],
  );
  assert.deepEqual(
    verified.toolResults.map((v) => v.effect),
    ["read", "read", "read", "read", "project-check", "project-check", "project-check", "unknown"],
  );
  assert.deepEqual(
    verified.toolResults.map((v) => v.commandId),
    commands,
  );
});

test("archive reads stay inspection and failures retain their actual error evidence", async () => {
  const value = await evidence(
    [
      [
        call(2, "archive", "read_continuity_context", {
          requestId: "id",
          collection: "messages",
          itemIndex: 0,
        }),
        result(3, "archive", "read_continuity_context"),
        call(4, "write", "write_file", { path: "result.md", content: "one" }),
        result(5, "write", "write_file", { isError: true }),
        call(6, "test", "run_command", { commandId: "project-test" }),
        result(7, "test", "run_command", { isError: true }),
        call(8, "output", "read_command_output", { logId: "11111111-1111-4111-8111-111111111111" }),
        result(9, "output", "read_command_output"),
      ],
    ],
    ["project-test"],
  );
  assert.deepEqual(
    value.toolResults.map((v) => [v.effect, v.isError]),
    [
      ["read", false],
      ["write", true],
      ["project-check", true],
      ["read", false],
    ],
  );
});

test("missing, mismatched, duplicate or later calls never acquire progress semantics", async () => {
  const value = await evidence([
    [
      result(2, "missing", "write_file", { details: { effect: "write" } }),
      call(3, "mismatch", "read_file", { path: "README.md" }),
      result(4, "mismatch", "write_file"),
      call(5, "duplicate", "write_file", { path: "result.md", content: "one" }),
      result(6, "duplicate", "write_file"),
      result(7, "late", "write_file"),
      call(8, "late", "write_file", { path: "result.md", content: "two" }),
    ],
    [
      call(9, "duplicate", "write_file", { path: "other.md", content: "three" }),
      call(10, "malformed", "edit_file", { path: "result.md", newText: "missing oldText" }),
      result(11, "malformed", "edit_file"),
    ],
  ]);
  assert.ok(value.toolResults.every((v) => v.effect === "unknown"));
  assert.ok(value.toolResults.slice(0, 4).every((v) => v.callEntryId === null));
});

test("incomplete/legacy and malformed ranged observations stay conservative", async () => {
  const pending = await describeSubmissionTools(rootFor([]), { ...record, status: "placed" }, {});
  assert.equal(pending.toolEvidenceComplete, false);
  assert.deepEqual(pending.toolResults, []);
  const legacy = await evidence([[result(2, "legacy", "write_file")]]);
  assert.equal(legacy.toolResults[0].effect, "unknown");
  const malformed = await evidence([
    [
      call(2, "write", "write_file", { path: "result.md", content: "one" }),
      result(3, "write", "write_file"),
      result(101, "outside", "write_file"),
    ],
  ]);
  assert.equal(malformed.toolEvidenceComplete, false);
  assert.equal(malformed.toolResults.length, 1);
});

test("identical overwrites and replacements do not establish progress", async () => {
  const value = await evidence([
    [
      call(2, "same-write", "write_file", {
        path: "result.md",
        content: "same",
        expectedContent: "same",
      }),
      result(3, "same-write", "write_file"),
      call(4, "same-edit", "edit_file", { path: "result.md", oldText: "same", newText: "same" }),
      result(5, "same-edit", "edit_file"),
    ],
  ]);
  assert.deepEqual(
    value.toolResults.map((item) => item.effect),
    ["unknown", "unknown"],
  );
});

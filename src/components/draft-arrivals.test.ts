import { describe, expect, it } from "vitest";
import type { ContinuityDraft } from "../runtime/continuity/types";
import { createDraftArrivalStore } from "./draft-arrivals";

const draft = (id: string, content = `Body ${id}`): ContinuityDraft => ({
  id,
  content,
  title: `Title ${id}`,
  reason: "A useful next step",
  sourceIds: ["message-1"],
  status: "ready",
  createdAt: 1,
  updatedAt: 1,
});

describe("draft arrival attention", () => {
  it("waits for the first nonnull snapshot and treats its ready drafts as history", () => {
    const entry = createDraftArrivalStore().forPersona("a");
    entry.observe(null);
    entry.observe([draft("old")]);
    expect(entry.getSnapshot()).toEqual([]);
    entry.observe([draft("old"), draft("new")]);
    expect(entry.getSnapshot()).toEqual([
      { id: "new", title: "Title new", content: "Body new", kind: "new" },
    ]);
  });

  it("retains multiple arrivals in order with only the latest body and title per draft", () => {
    const entry = createDraftArrivalStore().forPersona("a");
    entry.observe([draft("old")]);
    entry.observe([draft("old", "Updated old"), draft("new")]);
    entry.observe([
      draft("old", "Updated again"),
      { ...draft("new", "Latest body"), title: "Latest title" },
    ]);
    expect(entry.getSnapshot()).toEqual([
      { id: "old", title: "Title old", content: "Updated again", kind: "updated" },
      { id: "new", title: "Latest title", content: "Latest body", kind: "new" },
    ]);
    entry.acknowledge("old", "Updated old");
    expect(entry.getSnapshot()).toHaveLength(2);
    entry.acknowledge("old", "Updated again");
    expect(entry.getSnapshot().map((item) => item.id)).toEqual(["new"]);
  });

  it("refreshes pending metadata without requeuing an acknowledged body", () => {
    const entry = createDraftArrivalStore().forPersona("a");
    entry.observe([]);
    entry.observe([draft("a")]);
    const renamed = {
      ...draft("a"),
      title: "Renamed",
      reason: "Different reason",
      sourceIds: ["2", "1"],
      updatedAt: 5,
    };
    entry.observe([renamed]);
    expect(entry.getSnapshot()[0].title).toBe("Renamed");
    entry.acknowledge("a", "Body a");
    entry.observe([{ ...renamed, title: "Renamed again", sourceIds: ["1", "2"], updatedAt: 9 }]);
    expect(entry.getSnapshot()).toEqual([]);
    entry.observe([{ ...renamed, content: "Changed body" }]);
    expect(entry.getSnapshot()[0]).toMatchObject({ kind: "updated", content: "Changed body" });
  });

  it("prunes dismissed and removed drafts while recognizing a later ready arrival", () => {
    const entry = createDraftArrivalStore().forPersona("a");
    entry.observe([]);
    entry.observe([draft("removed"), draft("dismissed")]);
    entry.observe([{ ...draft("dismissed"), status: "dismissed" }]);
    expect(entry.getSnapshot()).toEqual([]);
    entry.observe([draft("dismissed")]);
    expect(entry.getSnapshot()[0].kind).toBe("new");
  });

  it("retains a session baseline across persona returns and aliases without leaking custom personas", () => {
    const store = createDraftArrivalStore();
    const yori = store.forPersona("yori-ja");
    yori.observe([draft("old")]);
    yori.observe([draft("old"), draft("new")]);
    const custom = store.forPersona("builtin:yori");
    custom.observe([draft("new")]);
    expect(custom.getSnapshot()).toEqual([]);
    const returned = store.forPersona("yori-en");
    expect(returned).toBe(yori);
    returned.observe([draft("old", "Updated while away"), draft("new")]);
    expect(returned.getSnapshot().map((item) => item.id)).toEqual(["new", "old"]);
    const reloaded = createDraftArrivalStore().forPersona("yori-ja");
    reloaded.observe([draft("old"), draft("new")]);
    expect(reloaded.getSnapshot()).toEqual([]);
  });
});

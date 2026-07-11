import { describe, expect, it, vi } from "vitest";
import { createLoopReelStore } from "./loop-reel-store";
import {
  createLoopReelPersistence,
  type LoopReelPersistedMeta,
  type LoopReelPersistenceBackend,
} from "./persistence";
import type { RecordedEntry } from "./types";

class MemoryLoopReelBackend implements LoopReelPersistenceBackend {
  readonly metas = new Map<string, LoopReelPersistedMeta>();
  readonly entries = new Map<string, string>();
  readonly createCalls: LoopReelPersistedMeta[] = [];
  readonly updateCalls: LoopReelPersistedMeta[] = [];
  readonly appendCalls: Array<{ readonly id: string; readonly jsonl: string }> = [];
  readonly deleteCalls: string[] = [];

  async create(meta: LoopReelPersistedMeta): Promise<void> {
    this.createCalls.push(meta);
    this.metas.set(meta.id, meta);
  }

  async updateMeta(id: string, meta: LoopReelPersistedMeta): Promise<void> {
    this.updateCalls.push(meta);
    this.metas.set(id, meta);
  }

  async appendEntries(id: string, jsonl: string): Promise<void> {
    this.appendCalls.push({ id, jsonl });
    const previous = this.entries.get(id);
    this.entries.set(id, previous ? `${previous}\n${jsonl}` : jsonl);
  }

  async list(): Promise<readonly LoopReelPersistedMeta[]> {
    return Array.from(this.metas.values()).sort((a, b) => b.startedAt - a.startedAt);
  }

  async loadEntries(id: string): Promise<string> {
    return this.entries.get(id) ?? "";
  }

  async delete(id: string): Promise<void> {
    this.deleteCalls.push(id);
    this.metas.delete(id);
    this.entries.delete(id);
  }
}

class DeferredAppendBackend extends MemoryLoopReelBackend {
  readonly deferreds: Array<{
    readonly id: string;
    readonly jsonl: string;
    readonly resolve: () => void;
  }> = [];

  override async appendEntries(id: string, jsonl: string): Promise<void> {
    this.appendCalls.push({ id, jsonl });
    await new Promise<void>((resolve) => {
      this.deferreds.push({ id, jsonl, resolve });
    });
    const previous = this.entries.get(id);
    this.entries.set(id, previous ? `${previous}\n${jsonl}` : jsonl);
  }
}

const ptyEntry = (text: string, timestamp: number): RecordedEntry => ({
  kind: "pty",
  text,
  timestamp,
});

const flushMicrotasks = async (count = 6): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
};

describe("LoopReelPersistence", () => {
  it("flushes buffered entries by count before memory trimming can lose them", async () => {
    const backend = new MemoryLoopReelBackend();
    const store = createLoopReelStore({ maxEntriesPerRecording: 3 });
    const persistence = createLoopReelPersistence(store, {
      backend,
      flushEntryCount: 2,
      flushIntervalMs: 1000,
    });

    store.startSession("default-session", { label: "codex", kind: "agent", timestamp: 100 });
    store.recordPty("default-session", "old\n", 110);
    store.recordPty("default-session", "middle\n", 120);
    store.recordPty("default-session", "new\n", 130);
    await persistence.flushAll();

    expect(store.list()[0].entries).toEqual([
      { kind: "marker", marker: "session-start", label: "codex", timestamp: 100 },
      ptyEntry("middle\n", 120),
      ptyEntry("new\n", 130),
    ]);
    expect(backend.entries.get("session-default-session-100-1")).toContain("old\\n");
  });

  it("flushes buffered entries on the timer", async () => {
    vi.useFakeTimers();
    try {
      const backend = new MemoryLoopReelBackend();
      const store = createLoopReelStore();
      createLoopReelPersistence(store, {
        backend,
        flushEntryCount: 64,
        flushIntervalMs: 1000,
      });

      store.startSession("default-session", { label: "codex", kind: "agent", timestamp: 100 });
      store.recordPty("default-session", "one\n", 110);

      expect(backend.appendCalls).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000);

      expect(backend.appendCalls).toHaveLength(1);
      expect(backend.entries.get("session-default-session-100-1")).toContain("one\\n");
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes immediately when a recording ends", async () => {
    const backend = new MemoryLoopReelBackend();
    const store = createLoopReelStore();
    const persistence = createLoopReelPersistence(store, {
      backend,
      flushEntryCount: 64,
      flushIntervalMs: 1000,
    });

    store.startSession("default-session", { label: "codex", kind: "agent", timestamp: 100 });
    store.recordPty("default-session", "done\n", 110);
    store.endSession("default-session", 120);
    await persistence.flushAll();

    const meta = backend.metas.get("session-default-session-100-1");
    expect(meta).toMatchObject({ status: "ended", endedAt: 120 });
    expect(backend.entries.get("session-default-session-100-1")).toContain("session-ended");
  });

  it("serializes append calls for the same recording id", async () => {
    const backend = new DeferredAppendBackend();
    const store = createLoopReelStore();
    const persistence = createLoopReelPersistence(store, {
      backend,
      flushEntryCount: 2,
      flushIntervalMs: 1000,
    });

    store.startSession("default-session", { label: "codex", kind: "agent", timestamp: 100 });
    store.recordPty("default-session", "one\n", 110);
    store.recordPty("default-session", "two\n", 120);
    await Promise.resolve();

    expect(backend.appendCalls).toHaveLength(1);
    const flushAll = persistence.flushAll();
    await Promise.resolve();
    expect(backend.appendCalls).toHaveLength(1);

    backend.deferreds[0].resolve();
    await flushMicrotasks();
    expect(backend.appendCalls).toHaveLength(2);

    backend.deferreds[1].resolve();
    await flushAll;
    expect(backend.entries.get("session-default-session-100-1")).toContain("two\\n");
  });

  it("repairs leftover recording metas as interrupted on startup", async () => {
    const backend = new MemoryLoopReelBackend();
    backend.metas.set("session-a", {
      id: "session-a",
      sessionId: "default-session",
      label: "codex",
      kind: "agent",
      origin: "lifecycle",
      startedAt: 100,
      endedAt: null,
      status: "recording",
    });
    const store = createLoopReelStore();
    const persistence = createLoopReelPersistence(store, {
      backend,
      time: { now: () => 500 },
    });

    await persistence.initialize();

    expect(backend.metas.get("session-a")).toMatchObject({
      status: "ended",
      endedAt: 500,
      interrupted: true,
    });
  });

  it("rotates old ended recordings without deleting active recordings", async () => {
    const backend = new MemoryLoopReelBackend();
    for (const meta of [
      {
        id: "old",
        sessionId: "s",
        label: "old",
        kind: "agent" as const,
        origin: "lifecycle" as const,
        startedAt: 100,
        endedAt: 110,
        status: "ended" as const,
      },
      {
        id: "new",
        sessionId: "s",
        label: "new",
        kind: "agent" as const,
        origin: "lifecycle" as const,
        startedAt: 200,
        endedAt: 210,
        status: "ended" as const,
      },
      {
        id: "active",
        sessionId: "s",
        label: "active",
        kind: "agent" as const,
        origin: "lifecycle" as const,
        startedAt: 300,
        endedAt: null,
        status: "recording" as const,
      },
    ] satisfies LoopReelPersistedMeta[]) {
      backend.metas.set(meta.id, meta);
    }
    const persistence = createLoopReelPersistence(createLoopReelStore(), {
      backend,
      maxPersistedRecordings: 2,
      time: { now: () => 400 },
    });

    await persistence.initialize();

    expect(backend.deleteCalls).toEqual(["old"]);
    expect(backend.metas.has("new")).toBe(true);
    expect(backend.metas.get("active")).toMatchObject({ interrupted: true, status: "ended" });
  });

  it("loads ended recording entries from disk", async () => {
    const backend = new MemoryLoopReelBackend();
    backend.metas.set("session-a", {
      id: "session-a",
      sessionId: "default-session",
      label: "codex",
      kind: "agent",
      origin: "lifecycle",
      startedAt: 100,
      endedAt: 130,
      status: "ended",
      outcome: "completed",
    });
    backend.entries.set(
      "session-a",
      [
        JSON.stringify({ kind: "marker", marker: "session-start", label: "codex", timestamp: 100 }),
        JSON.stringify(ptyEntry("hello\n", 110)),
      ].join("\n"),
    );
    const persistence = createLoopReelPersistence(createLoopReelStore(), { backend });

    const recording = await persistence.loadRecording("session-a");

    expect(recording).toMatchObject({
      id: "session-a",
      status: "ended",
      entries: [
        { kind: "marker", marker: "session-start", label: "codex", timestamp: 100 },
        ptyEntry("hello\n", 110),
      ],
    });
  });
});

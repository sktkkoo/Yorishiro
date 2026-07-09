import type { ObservedEvent } from "@yorishiro/sdk";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SESSION_ID } from "../sessions/types";
import { createLoopReelStore } from "./loop-reel-store";

const loopEvent = (
  phase: Extract<ObservedEvent, { kind: "loop-lifecycle" }>["phase"],
  timestamp: number,
  agent: string | null = "codex",
  detail?: unknown,
): Extract<ObservedEvent, { kind: "loop-lifecycle" }> => ({
  kind: "loop-lifecycle",
  phase,
  agent,
  detail,
  timestamp,
});

describe("LoopReelStore as session recorder", () => {
  it("does not create a recording from PTY output without an active recording", () => {
    const store = createLoopReelStore();

    store.recordPty("default-session", "npm test\n", 110);

    expect(store.list()).toEqual([]);
  });

  it("does not create a recording from resize or marker without an active recording", () => {
    const store = createLoopReelStore();

    store.recordResize("default-session", 80, 24, 110);
    store.recordMarker("default-session", "session-resume", "ignored", undefined, 120);

    expect(store.list()).toEqual([]);
  });

  it("records PTY output after an explicit session start", () => {
    const store = createLoopReelStore();

    store.startSession("default-session", {
      label: "codex",
      kind: "agent",
      timestamp: 100,
    });
    store.recordPty("default-session", "npm test\n", 110);
    store.recordPty("default-session", "passed\n", 120);

    expect(store.list()).toEqual([
      {
        id: "session-default-session-100-1",
        sessionId: "default-session",
        label: "codex",
        kind: "agent",
        origin: "manual",
        startedAt: 100,
        endedAt: null,
        status: "recording",
        entries: [
          {
            kind: "marker",
            marker: "session-start",
            label: "codex",
            timestamp: 100,
          },
          { kind: "pty", text: "npm test\n", timestamp: 110 },
          { kind: "pty", text: "passed\n", timestamp: 120 },
        ],
        interrupted: undefined,
        outcome: undefined,
      },
    ]);
  });

  it("uses the injected clock when timestamps are omitted", () => {
    const store = createLoopReelStore({ time: { now: () => 4242 } });

    store.startSession("default-session", { label: "codex", kind: "agent" });
    store.recordPty("default-session", "now\n");

    expect(store.list()[0]).toMatchObject({
      id: "session-default-session-4242-1",
      startedAt: 4242,
      entries: [
        { kind: "marker", marker: "session-start", label: "codex", timestamp: 4242 },
        { kind: "pty", text: "now\n", timestamp: 4242 },
      ],
    });
  });

  it("records initial terminal geometry when a session starts", () => {
    const store = createLoopReelStore();

    store.startSession("default-session", {
      label: "codex",
      kind: "agent",
      timestamp: 100,
      geometry: { cols: 120, rows: 34 },
    });

    expect(store.list()[0].entries).toEqual([
      { kind: "marker", marker: "session-start", label: "codex", timestamp: 100 },
      { kind: "resize", cols: 120, rows: 34, timestamp: 100 },
    ]);
  });

  it("records terminal resize entries for replay fidelity", () => {
    const store = createLoopReelStore();

    store.startSession("default-session", { label: "codex", kind: "agent", timestamp: 100 });
    store.recordResize("default-session", 99.8, 28.2, 150);

    expect(store.list()[0].entries).toContainEqual({
      kind: "resize",
      cols: 99,
      rows: 28,
      timestamp: 150,
    });
  });

  it("deduplicates unchanged terminal resize entries", () => {
    const store = createLoopReelStore();

    store.startSession("default-session", {
      label: "codex",
      kind: "agent",
      timestamp: 100,
      geometry: { cols: 80, rows: 24 },
    });
    store.recordResize("default-session", 80, 24, 120);
    store.recordResize("default-session", 100, 30, 130);
    store.recordResize("default-session", 100, 30, 140);

    expect(store.list()[0].entries).toEqual([
      { kind: "marker", marker: "session-start", label: "codex", timestamp: 100 },
      { kind: "resize", cols: 80, rows: 24, timestamp: 100 },
      { kind: "resize", cols: 100, rows: 30, timestamp: 130 },
    ]);
  });

  it("keeps recordings separated per session id", () => {
    const store = createLoopReelStore();

    store.startSession("default-session", { label: "claude", kind: "agent", timestamp: 100 });
    store.startSession("shell-1", { label: "shell", kind: "shell", timestamp: 200 });
    store.recordPty("default-session", "agent output\n", 210);
    store.recordPty("shell-1", "shell output\n", 220);

    const recordings = store.list();
    expect(recordings).toHaveLength(2);
    expect(recordings[0]).toMatchObject({
      id: "session-shell-1-200-2",
      sessionId: "shell-1",
      label: "shell",
      kind: "shell",
    });
    expect(recordings[0].entries).toContainEqual({
      kind: "pty",
      text: "shell output\n",
      timestamp: 220,
    });
    expect(recordings[1]).toMatchObject({
      id: "session-default-session-100-1",
      sessionId: "default-session",
      label: "claude",
      kind: "agent",
    });
    expect(recordings[1].entries).toContainEqual({
      kind: "pty",
      text: "agent output\n",
      timestamp: 210,
    });
  });

  it("uses loop lifecycle started and completed as recording boundaries", () => {
    const store = createLoopReelStore();

    store.recordPty("default-session", "ignored\n", 90);
    store.recordLifecycle(
      "default-session",
      loopEvent("started", 100, "codex", { summary: "implement replay" }),
    );
    store.recordPty("default-session", "working\n", 110);
    store.recordLifecycle(
      "default-session",
      loopEvent("progress-milestone", 120, "codex", { milestone: "tests pass" }),
    );
    store.recordLifecycle("default-session", loopEvent("completed", 130, "codex"));
    store.recordPty("default-session", "still in same session\n", 140);

    const [recording] = store.list();
    expect(recording.status).toBe("ended");
    expect(recording.endedAt).toBe(130);
    expect(recording.outcome).toBe("completed");
    expect(recording.entries).toContainEqual({
      kind: "phase",
      phase: "started",
      agent: "codex",
      detail: { summary: "implement replay" },
      timestamp: 100,
    });
    expect(recording.entries).toContainEqual({
      kind: "phase",
      phase: "progress-milestone",
      agent: "codex",
      detail: { milestone: "tests pass" },
      timestamp: 120,
    });
    expect(recording.entries).toContainEqual({
      kind: "phase",
      phase: "completed",
      agent: "codex",
      detail: undefined,
      timestamp: 130,
    });
    expect(recording.entries).not.toContainEqual({
      kind: "pty",
      text: "ignored\n",
      timestamp: 90,
    });
    expect(recording.entries).not.toContainEqual({
      kind: "pty",
      text: "still in same session\n",
      timestamp: 140,
    });
  });

  it("does not create a recording from non-started lifecycle phases", () => {
    const store = createLoopReelStore();

    store.setActiveSession("shell-1");
    store.recordLifecycle(
      store.getActiveSession() ?? DEFAULT_SESSION_ID,
      loopEvent("iterating", 110, "codex"),
    );

    expect(store.list()).toEqual([]);
  });

  it("records loop lifecycle in the currently active session when started", () => {
    const store = createLoopReelStore();

    store.setActiveSession("shell-1");
    store.recordLifecycle(
      store.getActiveSession() ?? DEFAULT_SESSION_ID,
      loopEvent("started", 100, "codex"),
    );
    store.recordLifecycle(
      store.getActiveSession() ?? DEFAULT_SESSION_ID,
      loopEvent("iterating", 110, "codex"),
    );

    const [recording] = store.list();
    expect(recording.sessionId).toBe("shell-1");
    expect(recording.entries).toContainEqual({
      kind: "phase",
      phase: "iterating",
      agent: "codex",
      detail: undefined,
      timestamp: 110,
    });
  });

  it("routes non-started lifecycle phases back to the single active lifecycle recording", () => {
    const store = createLoopReelStore();

    expect(store.recordLifecycle("session-a", loopEvent("started", 100, "codex"))).toBe(
      "session-a",
    );
    store.setActiveSession("session-b");
    expect(store.recordLifecycle("session-b", loopEvent("completed", 130, "codex"))).toBe(
      "session-a",
    );

    const [recording] = store.list();
    expect(recording).toMatchObject({
      sessionId: "session-a",
      origin: "lifecycle",
      status: "ended",
      outcome: "completed",
      endedAt: 130,
    });
  });

  it("does not let a concurrent manual recording steal lifecycle routing", () => {
    const store = createLoopReelStore();

    store.recordLifecycle("session-a", loopEvent("started", 100, "codex"));
    store.startSession("session-b", { label: "manual", kind: "shell", timestamp: 110 });
    expect(store.recordLifecycle("session-b", loopEvent("failed", 140, "codex"))).toBe("session-a");

    const lifecycle = store.list().find((recording) => recording.sessionId === "session-a");
    const manual = store.list().find((recording) => recording.sessionId === "session-b");
    expect(lifecycle).toMatchObject({
      origin: "lifecycle",
      status: "ended",
      outcome: "failed",
    });
    expect(manual).toMatchObject({
      origin: "manual",
      status: "recording",
    });
    expect(
      manual?.entries.some((entry) => entry.kind === "phase" && entry.phase === "failed"),
    ).toBe(false);
  });

  it("falls back for non-started lifecycle phases when multiple lifecycle recordings are active", () => {
    const store = createLoopReelStore();

    store.recordLifecycle("session-a", loopEvent("started", 100, "codex"));
    store.recordLifecycle("session-b", loopEvent("started", 110, "codex"));

    expect(store.recordLifecycle("session-c", loopEvent("completed", 140, "codex"))).toBeNull();
    expect(
      store
        .list()
        .flatMap((recording) => recording.entries)
        .filter((entry) => entry.kind === "phase" && entry.phase === "completed"),
    ).toEqual([]);
  });

  it("falls back to the default session for loop lifecycle when no session is active", () => {
    const store = createLoopReelStore();

    store.recordLifecycle(
      store.getActiveSession() ?? DEFAULT_SESSION_ID,
      loopEvent("started", 110, "claude"),
    );

    const [recording] = store.list();
    expect(recording.sessionId).toBe(DEFAULT_SESSION_ID);
    expect(recording.entries).toContainEqual({
      kind: "phase",
      phase: "started",
      agent: "claude",
      detail: undefined,
      timestamp: 110,
    });
  });

  it("does not create a second recording for duplicate started lifecycle events", () => {
    const store = createLoopReelStore();

    store.recordLifecycle("default-session", loopEvent("started", 100, "codex"));
    store.recordLifecycle("default-session", loopEvent("started", 110, "codex"));

    const recordings = store.list();
    expect(recordings).toHaveLength(1);
    expect(
      recordings[0].entries.filter((entry) => entry.kind === "phase" && entry.phase === "started"),
    ).toHaveLength(1);
  });

  it("tracks the active Yorishiro session for UI selection without creating empty recordings", () => {
    const store = createLoopReelStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.setActiveSession("default-session");
    store.setActiveSession("shell-1");
    store.setActiveSession("shell-1");

    expect(store.getActiveSession()).toBe("shell-1");
    expect(store.list()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("returns stable recording snapshots until that recording changes", () => {
    const store = createLoopReelStore();

    store.startSession("default-session", { label: "codex", kind: "agent", timestamp: 100 });
    store.startSession("shell-1", { label: "shell", kind: "shell", timestamp: 200 });

    const first = store.list();
    const second = store.list();
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);

    store.setActiveSession("shell-1");
    const afterSelection = store.list();
    expect(afterSelection[0]).toBe(first[0]);
    expect(afterSelection[1]).toBe(first[1]);

    store.recordPty("default-session", "new output\n", 230);
    const afterMutation = store.list();
    expect(afterMutation[0]).toBe(first[0]);
    expect(afterMutation[1]).not.toBe(first[1]);
    expect(afterMutation[1].entries).toContainEqual({
      kind: "pty",
      text: "new output\n",
      timestamp: 230,
    });
  });

  it("coalesces PTY output notifications while keeping entries immediately readable", () => {
    vi.useFakeTimers();
    try {
      const store = createLoopReelStore();
      const listener = vi.fn();
      store.subscribe(listener);

      store.startSession("default-session", { label: "codex", kind: "agent", timestamp: 100 });
      listener.mockClear();

      store.recordPty("default-session", "first\n", 110);
      store.recordPty("default-session", "second\n", 120);

      expect(store.list()[0].entries).toContainEqual({
        kind: "pty",
        text: "second\n",
        timestamp: 120,
      });
      expect(listener).not.toHaveBeenCalled();

      vi.runAllTimers();

      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records resume, rewind, and end markers", () => {
    const store = createLoopReelStore();

    store.startSession("default-session", { label: "claude", kind: "agent", timestamp: 100 });
    store.recordMarker(
      "default-session",
      "session-resume",
      "attached existing PTY",
      undefined,
      150,
    );
    store.recordMarker("default-session", "session-rewind", "history restore #4", { seq: 4 }, 170);
    store.endSession("default-session", 200);

    const [recording] = store.list();
    expect(recording.status).toBe("ended");
    expect(recording.endedAt).toBe(200);
    expect(recording.entries).toEqual([
      { kind: "marker", marker: "session-start", label: "claude", timestamp: 100 },
      {
        kind: "marker",
        marker: "session-resume",
        label: "attached existing PTY",
        detail: undefined,
        timestamp: 150,
      },
      {
        kind: "marker",
        marker: "session-rewind",
        label: "history restore #4",
        detail: { seq: 4 },
        timestamp: 170,
      },
      { kind: "marker", marker: "session-ended", label: "Session ended", timestamp: 200 },
    ]);
  });

  it("drops old pty entries at the cap, warns once, and keeps structured markers", () => {
    const warn = vi.fn();
    const store = createLoopReelStore({ maxEntriesPerRecording: 4, warn });

    store.startSession("default-session", { label: "codex", kind: "agent", timestamp: 100 });
    store.recordPty("default-session", "old\n", 110);
    store.recordLifecycle("default-session", loopEvent("iterating", 120));
    store.recordPty("default-session", "middle\n", 130);
    store.recordPty("default-session", "new\n", 140);
    store.recordPty("default-session", "newer\n", 150);

    const [recording] = store.list();
    expect(recording.entries).toEqual([
      { kind: "marker", marker: "session-start", label: "codex", timestamp: 100 },
      {
        kind: "phase",
        phase: "iterating",
        agent: "codex",
        detail: undefined,
        timestamp: 120,
      },
      { kind: "pty", text: "new\n", timestamp: 140 },
      { kind: "pty", text: "newer\n", timestamp: 150 },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("emits append callbacks before memory trimming drops old PTY entries", () => {
    const appended = vi.fn();
    const store = createLoopReelStore({
      maxEntriesPerRecording: 3,
      callbacks: { onEntriesAppended: appended },
    });

    store.startSession("default-session", { label: "codex", kind: "agent", timestamp: 100 });
    store.recordPty("default-session", "old\n", 110);
    store.recordPty("default-session", "middle\n", 120);
    store.recordPty("default-session", "new\n", 130);

    expect(store.list()[0].entries).toEqual([
      { kind: "marker", marker: "session-start", label: "codex", timestamp: 100 },
      { kind: "pty", text: "middle\n", timestamp: 120 },
      { kind: "pty", text: "new\n", timestamp: 130 },
    ]);
    expect(appended.mock.calls.map((call) => call[0].entries)).toEqual([
      [{ kind: "marker", marker: "session-start", label: "codex", timestamp: 100 }],
      [{ kind: "pty", text: "old\n", timestamp: 110 }],
      [{ kind: "pty", text: "middle\n", timestamp: 120 }],
      [{ kind: "pty", text: "new\n", timestamp: 130 }],
    ]);
  });

  it("evicts the oldest ended recordings at the recording cap", () => {
    const warn = vi.fn();
    const store = createLoopReelStore({ maxRecordings: 2, warn });

    store.startSession("default-session", { label: "codex", kind: "agent", timestamp: 100 });
    store.endSession("default-session", 110);
    store.startSession("shell-1", { label: "shell", kind: "shell", timestamp: 200 });
    store.endSession("shell-1", 210);
    store.startSession("shell-2", { label: "shell 2", kind: "shell", timestamp: 300 });

    const recordings = store.list();
    expect(recordings.map((recording) => recording.sessionId)).toEqual(["shell-2", "shell-1"]);
    expect(recordings.map((recording) => recording.status)).toEqual(["recording", "ended"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "LoopReelStore: recording cap reached; old ended recordings were dropped",
      {
        recordingId: "session-default-session-100-1",
        maxRecordings: 2,
      },
    );
  });

  it("does not evict recording sessions even when they exceed the recording cap", () => {
    const warn = vi.fn();
    const store = createLoopReelStore({ maxRecordings: 1, warn });

    store.startSession("default-session", { label: "codex", kind: "agent", timestamp: 100 });
    store.startSession("shell-1", { label: "shell", kind: "shell", timestamp: 200 });

    expect(store.list().map((recording) => recording.sessionId)).toEqual([
      "shell-1",
      "default-session",
    ]);
    expect(warn).not.toHaveBeenCalled();

    store.endSession("default-session", 250);

    expect(store.list().map((recording) => recording.sessionId)).toEqual(["shell-1"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

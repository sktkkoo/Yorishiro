import type { IMarker } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { TerminalCommandRunStore } from "./command-run-store";

function marker(line: number): IMarker {
  return {
    id: line,
    line,
    isDisposed: false,
    onDispose: vi.fn(),
    dispose: vi.fn(),
  } as unknown as IMarker;
}

describe("TerminalCommandRunStore", () => {
  it("creates a running run from pending command and cwd", () => {
    const store = new TerminalCommandRunStore("shell-1");
    const startMarker = marker(10);

    store.setPendingCommand("npm test");
    store.setCurrentCwd("/repo");
    const run = store.start({ startMarker, startedAt: 1000 });

    expect(run).toMatchObject({
      id: 1,
      sessionId: "shell-1",
      command: "npm test",
      cwd: "/repo",
      status: "running",
      completedBy: null,
      startedAt: 1000,
    });
    expect(run.startMarker).toBe(startMarker);
  });

  it("finalizes active run with osc133 exit code and duration", () => {
    const store = new TerminalCommandRunStore("shell-1");
    store.setPendingCommand("cargo test");
    store.start({ startMarker: marker(1), startedAt: 1000 });

    const finalized = store.finalizeActive({
      completedBy: "osc133",
      exitCode: 1,
      endMarker: marker(12),
      endedAt: 3500,
    });

    expect(finalized).toMatchObject({
      command: "cargo test",
      status: "failed",
      completedBy: "osc133",
      exitCode: 1,
      endedAt: 3500,
      durationMs: 2500,
    });
    expect(store.getActiveRun()).toBeNull();
  });

  it("uses pty-exit code when OSC D is missing", () => {
    const store = new TerminalCommandRunStore("shell-1");
    store.start({ startMarker: marker(1), startedAt: 1000 });

    const finalized = store.finalizeActive({
      completedBy: "pty-exit",
      exitCode: 0,
      endMarker: marker(2),
      endedAt: 1100,
    });

    expect(finalized?.status).toBe("succeeded");
    expect(finalized?.completedBy).toBe("pty-exit");
  });

  it("disposes unused end marker when finalize has no active run", () => {
    const store = new TerminalCommandRunStore("shell-1");
    const endMarker = marker(2);

    const finalized = store.finalizeActive({
      completedBy: "osc133",
      exitCode: 0,
      endMarker,
      endedAt: 1100,
    });

    expect(finalized).toBeNull();
    expect(endMarker.dispose).toHaveBeenCalledOnce();
  });

  it("disposes unused end marker when active run is missing from storage", () => {
    const store = new TerminalCommandRunStore("shell-1");
    store.start({ startMarker: marker(1), startedAt: 1000 });
    (store as unknown as { runs: []; activeRunId: number }).runs = [];
    const endMarker = marker(2);

    const finalized = store.finalizeActive({
      completedBy: "osc133",
      exitCode: 0,
      endMarker,
      endedAt: 1100,
    });

    expect(finalized).toBeNull();
    expect(endMarker.dispose).toHaveBeenCalledOnce();
  });

  it("ignores duplicate start while a run is active", () => {
    const store = new TerminalCommandRunStore("shell-1");
    const firstMarker = marker(1);
    const duplicateMarker = marker(2);

    store.setPendingCommand("echo one && echo two");
    const first = store.start({ startMarker: firstMarker, startedAt: 1000 });
    store.setPendingCommand("echo two");
    const duplicate = store.start({ startMarker: duplicateMarker, startedAt: 1100 });

    expect(duplicate).toBe(first);
    expect(store.getRecent()).toHaveLength(1);
    expect(store.getActiveRun()?.command).toBe("echo one && echo two");
    expect(duplicateMarker.dispose).toHaveBeenCalledOnce();
  });

  it("marks session-dispose completion as unknown", () => {
    const store = new TerminalCommandRunStore("shell-1");
    store.start({ startMarker: marker(1), startedAt: 1000 });

    const finalized = store.finalizeForSessionDispose(1200, marker(2));

    expect(finalized?.status).toBe("unknown");
    expect(finalized?.completedBy).toBe("session-dispose");
    expect(finalized?.exitCode).toBeNull();
  });

  it("keeps only the configured recent run count", () => {
    const store = new TerminalCommandRunStore("shell-1", { maxRuns: 2 });
    const firstMarker = marker(1);

    store.start({ startMarker: firstMarker, startedAt: 1 });
    store.finalizeActive({ completedBy: "osc133", exitCode: 0, endMarker: marker(2), endedAt: 2 });
    store.start({ startMarker: marker(3), startedAt: 3 });
    store.finalizeActive({ completedBy: "osc133", exitCode: 0, endMarker: marker(4), endedAt: 4 });
    store.start({ startMarker: marker(5), startedAt: 5 });

    const recent = store.getRecent();
    expect(recent.map((run) => run.id)).toEqual([3, 2]);
    expect(firstMarker.dispose).toHaveBeenCalledOnce();
  });

  it("returns the most recent failed run", () => {
    const store = new TerminalCommandRunStore("shell-1");
    // id 1: succeeded
    store.start({ startMarker: marker(1), startedAt: 1000 });
    store.finalizeActive({
      completedBy: "osc133",
      exitCode: 0,
      endMarker: marker(2),
      endedAt: 1100,
    });
    // id 2: failed (older)
    store.start({ startMarker: marker(3), startedAt: 2000 });
    store.finalizeActive({
      completedBy: "osc133",
      exitCode: 1,
      endMarker: marker(4),
      endedAt: 2100,
    });
    // id 3: failed (newer)
    store.start({ startMarker: marker(5), startedAt: 3000 });
    store.finalizeActive({
      completedBy: "osc133",
      exitCode: 2,
      endMarker: marker(6),
      endedAt: 3100,
    });
    // id 4: succeeded (newest)
    store.start({ startMarker: marker(7), startedAt: 4000 });
    store.finalizeActive({
      completedBy: "osc133",
      exitCode: 0,
      endMarker: marker(8),
      endedAt: 4100,
    });

    const lastFailed = store.getLastFailedRun();
    expect(lastFailed?.id).toBe(3);
    expect(lastFailed?.exitCode).toBe(2);
  });

  it("returns null when there is no failed run", () => {
    const store = new TerminalCommandRunStore("shell-1");
    store.start({ startMarker: marker(1), startedAt: 1000 });
    store.finalizeActive({
      completedBy: "osc133",
      exitCode: 0,
      endMarker: marker(2),
      endedAt: 1100,
    });

    expect(store.getLastFailedRun()).toBeNull();
  });

  it("does not return a running run as last failed", () => {
    const store = new TerminalCommandRunStore("shell-1");
    store.start({ startMarker: marker(1), startedAt: 1000 });
    store.finalizeActive({
      completedBy: "osc133",
      exitCode: 1,
      endMarker: marker(2),
      endedAt: 1100,
    });
    // a new run is currently running (no exit yet)
    store.start({ startMarker: marker(3), startedAt: 2000 });

    expect(store.getLastFailedRun()?.id).toBe(1);
  });
});

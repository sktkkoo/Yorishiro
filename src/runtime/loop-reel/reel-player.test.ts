import { describe, expect, it } from "vitest";
import { buildReplayTimeline, replayDurationMs } from "./reel-player";
import type { SessionRecording } from "./types";

const recording: SessionRecording = {
  id: "session-default-session-100-1",
  sessionId: "default-session",
  label: "codex",
  kind: "agent",
  origin: "lifecycle",
  startedAt: 100,
  endedAt: 10_000,
  status: "ended",
  entries: [
    { kind: "marker", marker: "session-start", label: "codex", timestamp: 100 },
    { kind: "resize", cols: 80, rows: 24, timestamp: 100 },
    { kind: "pty", text: "\x1b[32mfirst\x1b[0m\n", timestamp: 200 },
    { kind: "phase", phase: "iterating", agent: "codex", timestamp: 300 },
    {
      kind: "marker",
      marker: "session-resume",
      label: "Ignore non-stream entries",
      timestamp: 400,
    },
    { kind: "pty", text: "after idle\n", timestamp: 5_200 },
    { kind: "resize", cols: 120, rows: 32, timestamp: 5_200 },
    { kind: "pty", text: "done\n", timestamp: 5_260 },
  ],
};

describe("reel-player", () => {
  it("builds stream frames from PTY and resize entries only", () => {
    const frames = buildReplayTimeline(recording, { maxGapMs: 1000 });

    expect(frames.map((frame) => frame.entry.kind)).toEqual([
      "resize",
      "pty",
      "pty",
      "resize",
      "pty",
    ]);
    expect(frames.map((frame) => frame.timestamp)).toEqual([100, 200, 5200, 5200, 5260]);
  });

  it("caps dead-time gaps while preserving short gaps", () => {
    const frames = buildReplayTimeline(recording, { maxGapMs: 1000 });

    expect(frames.map((frame) => frame.dueMs)).toEqual([0, 100, 1100, 1100, 1160]);
    expect(replayDurationMs(frames)).toBe(1160);
  });
});

import { describe, expect, it } from "vitest";
import type { LoopReelPersistedMeta } from "./persistence";
import {
  clampTimestamp,
  endedLoopReelMetas,
  mergeLoopReelMetas,
  nextClipTimestamp,
  nextFailedTimestamp,
  phaseMarkersOfRecording,
  previousClipTimestamp,
  recordingTimeRange,
} from "./player-state";
import type { SessionRecording } from "./types";

const meta = (id: string, startedAt: number, status: LoopReelPersistedMeta["status"] = "ended") =>
  ({
    id,
    sessionId: "default-session",
    label: id,
    kind: "agent",
    origin: "lifecycle",
    startedAt,
    endedAt: status === "ended" ? startedAt + 100 : null,
    status,
  }) satisfies LoopReelPersistedMeta;

describe("loop reel player state helpers", () => {
  it("merges persisted and memory metas with memory taking precedence", () => {
    const memory: LoopReelPersistedMeta = {
      ...meta("same", 300),
      label: "memory",
    };

    expect(mergeLoopReelMetas([meta("old", 100), meta("same", 200)], [memory])).toEqual([
      {
        id: "same",
        sessionId: "default-session",
        label: "memory",
        kind: "agent",
        origin: "lifecycle",
        startedAt: 300,
        endedAt: 400,
        status: "ended",
        outcome: undefined,
        interrupted: undefined,
      },
      meta("old", 100),
    ]);
  });

  it("filters player selection to ended recordings", () => {
    expect(endedLoopReelMetas([meta("recording", 200, "recording"), meta("ended", 100)])).toEqual([
      meta("ended", 100),
    ]);
  });

  it("derives a stable scrub range from recording timestamps", () => {
    const recording: SessionRecording = {
      ...meta("r1", 100),
      endedAt: null,
      entries: [
        { kind: "pty", text: "a", timestamp: 150 },
        { kind: "resize", cols: 80, rows: 24, timestamp: 180 },
      ],
    };

    expect(recordingTimeRange(recording)).toEqual({ fromTs: 100, toTs: 180 });
    expect(clampTimestamp(90, recordingTimeRange(recording))).toBe(100);
    expect(clampTimestamp(999, recordingTimeRange(recording))).toBe(180);
  });

  it("finds clip and failed jump targets", () => {
    const recording: SessionRecording = {
      ...meta("r1", 100),
      entries: [
        { kind: "phase", phase: "started", agent: null, timestamp: 100 },
        { kind: "phase", phase: "iterating", agent: null, timestamp: 200 },
        { kind: "phase", phase: "failed", agent: null, timestamp: 250 },
        { kind: "phase", phase: "iterating", agent: null, timestamp: 300 },
      ],
    };
    const clips = [
      { index: 0, fromTs: 100, toTs: 200, markers: [] },
      { index: 1, fromTs: 200, toTs: 300, markers: [] },
      { index: 2, fromTs: 300, toTs: 400, markers: [] },
    ];

    expect(previousClipTimestamp(clips, 260)).toBe(200);
    expect(nextClipTimestamp(clips, 260)).toBe(300);
    expect(nextFailedTimestamp(recording, 200)).toBe(250);
    expect(nextFailedTimestamp(recording, 250)).toBeNull();
  });

  it("sorts phase markers by timestamp", () => {
    const recording: SessionRecording = {
      ...meta("r1", 100),
      entries: [
        { kind: "phase", phase: "completed", agent: null, timestamp: 300 },
        { kind: "pty", text: "x", timestamp: 200 },
        { kind: "phase", phase: "started", agent: null, timestamp: 100 },
      ],
    };

    expect(phaseMarkersOfRecording(recording)).toEqual([
      { phase: "started", timestamp: 100 },
      { phase: "completed", timestamp: 300 },
    ]);
  });
});

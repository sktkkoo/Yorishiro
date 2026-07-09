import { describe, expect, it } from "vitest";
import { buildIterationClips } from "./iteration-clips";
import type { SessionRecording } from "./types";

const baseRecording = (entries: SessionRecording["entries"]): SessionRecording => ({
  id: "session-default-session-100-1",
  sessionId: "default-session",
  label: "codex",
  kind: "agent",
  origin: "lifecycle",
  startedAt: 100,
  endedAt: 500,
  status: "ended",
  entries,
});

describe("buildIterationClips", () => {
  it("uses started and each iterating phase as clip boundaries", () => {
    const clips = buildIterationClips(
      baseRecording([
        { kind: "phase", phase: "started", agent: "codex", timestamp: 100 },
        { kind: "pty", text: "one\n", timestamp: 120 },
        { kind: "phase", phase: "iterating", agent: "codex", timestamp: 200 },
        { kind: "phase", phase: "iterating", agent: "codex", timestamp: 300 },
        { kind: "phase", phase: "completed", agent: "codex", timestamp: 450 },
      ]),
    );

    expect(clips).toEqual([
      { index: 0, fromTs: 100, toTs: 200, endPhase: "iterating", markers: [] },
      { index: 1, fromTs: 200, toTs: 300, endPhase: "iterating", markers: [] },
      {
        index: 2,
        fromTs: 300,
        toTs: 450,
        endPhase: "completed",
        markers: [{ phase: "completed", timestamp: 450, detail: undefined }],
      },
    ]);
  });

  it("exposes progress, blocked, failed, and completed phases as markers", () => {
    const clips = buildIterationClips(
      baseRecording([
        { kind: "phase", phase: "started", agent: "codex", timestamp: 100 },
        {
          kind: "phase",
          phase: "progress-milestone",
          agent: "codex",
          detail: { milestone: "tests" },
          timestamp: 150,
        },
        { kind: "phase", phase: "blocked-on-approval", agent: "codex", timestamp: 180 },
        { kind: "phase", phase: "iterating", agent: "codex", timestamp: 240 },
        {
          kind: "phase",
          phase: "failed",
          agent: "codex",
          detail: { reason: "lint" },
          timestamp: 360,
        },
      ]),
    );

    expect(clips[0].markers).toEqual([
      { phase: "progress-milestone", timestamp: 150, detail: { milestone: "tests" } },
      { phase: "blocked-on-approval", timestamp: 180, detail: undefined },
    ]);
    expect(clips[1]).toMatchObject({
      fromTs: 240,
      toTs: 360,
      endPhase: "failed",
      markers: [{ phase: "failed", timestamp: 360, detail: { reason: "lint" } }],
    });
  });

  it("assigns a same-timestamp marker to only one clip at a boundary", () => {
    const clips = buildIterationClips(
      baseRecording([
        { kind: "phase", phase: "started", agent: "codex", timestamp: 100 },
        { kind: "phase", phase: "progress-milestone", agent: "codex", timestamp: 200 },
        { kind: "phase", phase: "iterating", agent: "codex", timestamp: 200 },
        { kind: "phase", phase: "completed", agent: "codex", timestamp: 300 },
      ]),
    );

    expect(clips[0].markers).toEqual([]);
    expect(clips[1].markers).toEqual([
      { phase: "progress-milestone", timestamp: 200, detail: undefined },
      { phase: "completed", timestamp: 300, detail: undefined },
    ]);
  });

  it("returns an empty clip list for manual recordings without phase entries", () => {
    const clips = buildIterationClips(
      baseRecording([
        { kind: "marker", marker: "session-start", label: "manual", timestamp: 100 },
        { kind: "pty", text: "manual\n", timestamp: 120 },
      ]),
    );

    expect(clips).toEqual([]);
  });
});

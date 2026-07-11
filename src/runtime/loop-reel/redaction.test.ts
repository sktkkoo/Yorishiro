import { describe, expect, it } from "vitest";
import {
  type LoopReelRedactionSources,
  redactionTerms,
  redactLoopReelEntries,
  redactLoopReelRecording,
} from "./redaction";
import type { RecordedEntry, SessionRecording } from "./types";

const SOURCES: LoopReelRedactionSources = {
  username: "alice",
  homeBasename: "alice",
  hostname: "workstation",
  gitUserName: "Alice Example",
  gitUserEmail: "alice@example.com",
};

describe("loop reel redaction", () => {
  it("masks terms across PTY chunk boundaries while preserving chunk lengths", () => {
    const entries: RecordedEntry[] = [
      { kind: "pty", text: "cd /Users/al", timestamp: 1 },
      { kind: "pty", text: "ice/project && ssh work", timestamp: 2 },
      { kind: "pty", text: "station\n", timestamp: 3 },
    ];

    const redacted = redactLoopReelEntries(entries, SOURCES);

    expect(redacted.map((entry) => (entry.kind === "pty" ? entry.text : "")).join("")).toBe(
      "cd /Users/*****" + "/project && ssh ***********\n",
    );
    expect(redacted.map((entry) => (entry.kind === "pty" ? entry.text.length : 0))).toEqual(
      entries.map((entry) => (entry.kind === "pty" ? entry.text.length : 0)),
    );
  });

  it("leaves raw entries untouched and only returns a display projection", () => {
    const entries: RecordedEntry[] = [{ kind: "pty", text: "git by Alice Example", timestamp: 1 }];

    const redacted = redactLoopReelEntries(entries, SOURCES);

    expect(entries[0]).toEqual({ kind: "pty", text: "git by Alice Example", timestamp: 1 });
    expect(redacted[0]).toEqual({ kind: "pty", text: "git by *************", timestamp: 1 });
  });

  it("keeps non-PTY entries unchanged", () => {
    const entries: RecordedEntry[] = [
      { kind: "pty", text: "alice@example.com", timestamp: 1 },
      { kind: "resize", cols: 80, rows: 24, timestamp: 2 },
      {
        kind: "marker",
        marker: "session-ended",
        label: "alice@example.com",
        timestamp: 3,
      },
    ];

    const redacted = redactLoopReelEntries(entries, SOURCES);

    expect(redacted[0]).toEqual({ kind: "pty", text: "*****************", timestamp: 1 });
    expect(redacted[1]).toBe(entries[1]);
    expect(redacted[2]).toBe(entries[2]);
  });

  it("falls back to a single UTF-16 code unit replacement for astral mask characters", () => {
    const entries: RecordedEntry[] = [{ kind: "pty", text: "alice", timestamp: 1 }];

    const redacted = redactLoopReelEntries(entries, SOURCES, { replacementChar: "🔒" });

    expect(redacted[0]).toEqual({ kind: "pty", text: "*****", timestamp: 1 });
  });

  it("normalizes duplicate and empty source values", () => {
    expect(
      redactionTerms({
        username: "alice",
        homeBasename: " alice ",
        hostname: "",
        gitUserName: "Alice Example",
        gitUserEmail: null,
      }),
    ).toEqual(["Alice Example", "alice"]);
  });

  it("returns the original recording when there is nothing to mask", () => {
    const recording: SessionRecording = {
      id: "recording-1",
      sessionId: "default-session",
      label: "Default",
      kind: "agent",
      origin: "manual",
      startedAt: 1,
      endedAt: 2,
      status: "ended",
      entries: [{ kind: "pty", text: "public", timestamp: 1 }],
    };

    expect(
      redactLoopReelRecording(recording, {
        username: null,
        homeBasename: null,
        hostname: null,
        gitUserName: null,
        gitUserEmail: null,
      }),
    ).toBe(recording);
  });
});

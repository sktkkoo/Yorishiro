// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  appendRealtimeDiagnostic,
  classifyRealtimeFailure,
  readRealtimeDiagnostics,
  realtimeDiagnosticCode,
} from "./realtime-diagnostics";

describe("realtime diagnostics", () => {
  beforeEach(() => localStorage.clear());

  it.each([
    [new DOMException("denied", "NotAllowedError"), "microphone", "permission", false],
    [new Error("thread/realtime/start timed out"), "realtime-start", "timeout", true],
    [new Error("Codex app-server connection closed"), "bridge-connect", "network", true],
    [new Error("service temporarily unavailable (503)"), "realtime-start", "remote", true],
    [
      new Error("Multiple top-level Codex threads are loaded"),
      "thread-discovery",
      "ownership",
      false,
    ],
    [new Error("Invalid voice: maple"), "realtime-start", "configuration", false],
    [
      new Error("each initial realtime item must not exceed 8192 estimated tokens"),
      "realtime-start",
      "configuration",
      false,
    ],
  ] as const)("classifies %s", (error, stage, category, retryable) => {
    expect(classifyRealtimeFailure(error, stage)).toEqual({ category, retryable });
  });

  it("uses a finite structured code instead of persisting arbitrary error text", () => {
    const secret = "token=supersecretvalue123 candidate:secret-candidate";
    const classification = classifyRealtimeFailure(new Error(secret), "realtime-start");
    const code = realtimeDiagnosticCode(classification.category, "realtime-start");
    expect(code).toBe("remote.realtime-start");
    expect(code).not.toContain(secret);
  });

  it("treats thread discovery expiry as a retryable timeout", () => {
    expect(
      classifyRealtimeFailure(new Error("Codex thread was not loaded in time"), "thread-discovery"),
    ).toEqual({ category: "timeout", retryable: true });
  });

  it("persists only a bounded ring of sanitized structured records", () => {
    for (let index = 0; index < 45; index++) {
      appendRealtimeDiagnostic({
        attemptId: `attempt-${index}`,
        timestamp: new Date(index).toISOString(),
        stage: "preflight",
        event: "started",
        elapsedMs: 0,
        retryDecision: "none",
        terminationRequested: false,
      });
    }
    const records = readRealtimeDiagnostics();
    expect(records).toHaveLength(40);
    expect(records[0].attemptId).toBe("attempt-5");
    expect(records[records.length - 1]?.attemptId).toBe("attempt-44");
  });
  it("retains connection evidence when periodic output samples fill the ring", () => {
    localStorage.setItem("yorishiro:realtime-debug", "1");
    const base = {
      attemptId: "one",
      timestamp: "now",
      stage: "playback" as const,
      elapsedMs: 0,
      retryDecision: "none" as const,
      terminationRequested: false,
    };
    appendRealtimeDiagnostic({ ...base, event: "negotiated" });
    for (let index = 0; index < 100; index++)
      appendRealtimeDiagnostic({ ...base, event: "playback-sample" });
    const records = readRealtimeDiagnostics();
    expect(records).toHaveLength(13);
    expect(records[0].event).toBe("negotiated");
  });
  it("does not persist investigative samples without local opt-in", () => {
    appendRealtimeDiagnostic({
      attemptId: "one",
      timestamp: "now",
      stage: "playback",
      event: "playback-sample",
      elapsedMs: 0,
      retryDecision: "none",
      terminationRequested: false,
    });
    expect(readRealtimeDiagnostics()).toEqual([]);
  });
});

// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  appendCodexRealtimePersonaDiagnostic,
  CODEX_REALTIME_PERSONA_DIAGNOSTICS_KEY,
  readCodexRealtimePersonaDiagnostics,
} from "./persona-diagnostics";

describe("GPT Live persona diagnostics", () => {
  beforeEach(() => localStorage.clear());

  it("persists prompt-free evidence for an accepted persona start", () => {
    appendCodexRealtimePersonaDiagnostic(
      {
        personaId: "yori-ja",
        status: "applied",
        appServerVersion: "0.146.0",
        delivery: "initial-items",
      },
      localStorage,
      () => new Date("2026-08-02T12:00:00.000Z"),
    );

    expect(readCodexRealtimePersonaDiagnostics()).toEqual([
      {
        timestamp: "2026-08-02T12:00:00.000Z",
        personaId: "yori-ja",
        status: "applied",
        appServerVersion: "0.146.0",
        initialItemsSent: true,
        sessionActive: true,
        delivery: "initial-items",
        startupContextIncluded: null,
      },
    ]);
    expect(localStorage.getItem(CODEX_REALTIME_PERSONA_DIAGNOSTICS_KEY)).not.toContain("prompt");
  });

  it("keeps a bounded ring and records fallback without claiming items were sent", () => {
    for (let index = 0; index < 15; index++) {
      appendCodexRealtimePersonaDiagnostic(
        { personaId: "yori-ja", status: "unsupported", appServerVersion: "0.145.0" },
        localStorage,
        () => new Date(index),
      );
    }

    const records = readCodexRealtimePersonaDiagnostics();
    expect(records).toHaveLength(12);
    expect(records[0]?.timestamp).toBe(new Date(3).toISOString());
    expect(records[records.length - 1]).toMatchObject({
      status: "unsupported",
      initialItemsSent: false,
      sessionActive: true,
      delivery: "none",
    });
  });

  it("does not claim initial items were sent during prompt replacement", () => {
    appendCodexRealtimePersonaDiagnostic({
      personaId: "yori-ja",
      status: "applied",
      appServerVersion: "0.146.0",
      delivery: "prompt-replacement",
    });

    const records = readCodexRealtimePersonaDiagnostics();
    expect(records[records.length - 1]).toMatchObject({
      delivery: "prompt-replacement",
      initialItemsSent: false,
    });
  });
});

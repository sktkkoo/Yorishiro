/**
 * LoadReport の build logic — pure fn として閉じ込める。
 *
 * Rust 側が atomic に file に書く。この module は load 結果 + メタ情報
 * から LoadReport object を組むことだけに責務を絞る。
 *
 * Internal design-record: 2026-04-18-phase-1c-rescue-and-mcp.md Section 4.2
 */

import { describe, expect, it } from "vitest";
import { buildLoadReport } from "./load-report";

describe("buildLoadReport", () => {
  it("builds a report with all-loaded entries", () => {
    const report = buildLoadReport({
      timestamp: "2026-04-18T14:32:11.000Z",
      safeMode: false,
      result: {
        loaded: [
          { id: "fireworks", kind: "effect" },
          { id: "clai", kind: "persona" },
        ],
        failed: [],
      },
    });
    expect(report).toEqual({
      timestamp: "2026-04-18T14:32:11.000Z",
      safeMode: false,
      loadResults: [
        { id: "fireworks", kind: "effect", status: "loaded" },
        { id: "clai", kind: "persona", status: "loaded" },
      ],
    });
  });

  it("includes failed entries with error info", () => {
    const report = buildLoadReport({
      timestamp: "2026-04-18T15:00:00.000Z",
      safeMode: false,
      result: {
        loaded: [{ id: "ok", kind: "effect" }],
        failed: [
          {
            id: "broken",
            kind: "persona",
            error: "SyntaxError: Unexpected token",
          },
        ],
      },
    });
    expect(report.loadResults).toHaveLength(2);
    expect(report.loadResults[0]).toEqual({
      id: "ok",
      kind: "effect",
      status: "loaded",
    });
    expect(report.loadResults[1]).toEqual({
      id: "broken",
      kind: "persona",
      status: "failed",
      error: { phase: "import", message: "SyntaxError: Unexpected token" },
    });
  });

  it("marks safeMode true when requested", () => {
    const report = buildLoadReport({
      timestamp: "2026-04-18T16:00:00.000Z",
      safeMode: true,
      result: { loaded: [], failed: [] },
    });
    expect(report.safeMode).toBe(true);
    expect(report.loadResults).toEqual([]);
  });

  it("classifies PackValidationError-shaped errors as validate phase", () => {
    const report = buildLoadReport({
      timestamp: "2026-04-18T17:00:00.000Z",
      safeMode: false,
      result: {
        loaded: [],
        failed: [
          {
            id: "bad-shape",
            kind: "effect",
            error: "PackValidationError: 'kind' is required",
          },
        ],
      },
    });
    expect(report.loadResults[0].error?.phase).toBe("validate");
  });
});

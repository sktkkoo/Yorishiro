import { describe, expect, it } from "vitest";
import {
  MAX_REALTIME_TEXT_JSON_BYTES,
  realtimeContextParts,
  realtimeTextBytes,
} from "./context-items";

const body = (part: string) => part.slice(part.indexOf("\n") + 1);

describe("bounded realtime context items", () => {
  it("retains short context exactly", () => {
    expect(realtimeContextParts("日本語の人格指示😀")).toEqual(["日本語の人格指示😀"]);
    expect(realtimeContextParts("evidence", "Passive refresh.\n")).toEqual([
      "Passive refresh.\nevidence",
    ]);
  });

  it("losslessly splits Japanese, emoji and JSON-escaped controls into safe items", () => {
    const original = '訂正😀\\"\n\u0000'.repeat(6_000);
    const parts = realtimeContextParts(original);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.map(body).join("")).toBe(original);
    for (const part of parts) {
      expect(realtimeTextBytes(part)).toBeLessThanOrEqual(MAX_REALTIME_TEXT_JSON_BYTES);
      expect(part).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u);
    }
  });

  it("repeats passive context guidance on every bounded fragment", () => {
    const prefix = "Host context refresh only. Do not greet, speak, or start work.\n";
    const original = "ユーザーの訂正を保持😀".repeat(3_000);
    const parts = realtimeContextParts(original, prefix);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((part) => body(part.slice(prefix.length))).join("")).toBe(original);
    for (const part of parts) {
      expect(part.startsWith(prefix)).toBe(true);
      expect(realtimeTextBytes(part)).toBeLessThanOrEqual(MAX_REALTIME_TEXT_JSON_BYTES);
    }
  });
});

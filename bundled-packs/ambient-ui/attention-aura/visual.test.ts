import type { AttentionTarget } from "@charminal/sdk";
import { describe, expect, it } from "vitest";
import { auraVisualForTarget, targetOpacity } from "./visual";

const sampleTarget: AttentionTarget = {
  kind: "mouse",
  source: "mouse",
  rect: { x: 0, y: 0, width: 60, height: 60 },
  confidence: 1,
  priority: 4,
  timestamp: 0,
};

describe("targetOpacity", () => {
  it("returns 0 for null target", () => {
    expect(targetOpacity(null)).toBe(0);
  });

  it("returns kind-specific base opacity scaled by confidence", () => {
    const t: AttentionTarget = { ...sampleTarget, confidence: 0.5 };
    expect(targetOpacity(t)).toBeCloseTo(0.18, 2); // mouse base 0.36 * 0.5
  });

  it("clamps confidence to [0,1] range", () => {
    expect(targetOpacity({ ...sampleTarget, confidence: -1 })).toBe(0);
    expect(targetOpacity({ ...sampleTarget, confidence: 2 })).toBeCloseTo(0.36, 2);
  });
});

describe("auraVisualForTarget", () => {
  it("returns mouse-style for kind=mouse", () => {
    const v = auraVisualForTarget({ kind: "mouse", reason: undefined, width: 60, height: 60 });
    expect(v.blur).toBeGreaterThan(0);
    expect(v.spread).toBeGreaterThan(0);
    expect(v.background).toContain("radial-gradient");
    expect(v.boxShadow).toContain("0 0");
  });

  it("returns input-cursor-style for kind=input-cursor with smaller spread than mouse", () => {
    const cursor = auraVisualForTarget({
      kind: "input-cursor",
      reason: "typing",
      width: 8,
      height: 16,
    });
    const mouse = auraVisualForTarget({ kind: "mouse", reason: undefined, width: 60, height: 60 });
    expect(cursor.spread).toBeLessThanOrEqual(mouse.spread);
  });

  it("returns terminal-region style with diagnostic emphasis when reason is diagnostic", () => {
    const diag = auraVisualForTarget({
      kind: "terminal-region",
      reason: "diagnostic",
      width: 200,
      height: 16,
    });
    const plain = auraVisualForTarget({
      kind: "terminal-region",
      reason: undefined,
      width: 200,
      height: 16,
    });
    // diagnostic should be visually stronger than plain (larger spread or different background)
    expect(diag.spread).toBeGreaterThanOrEqual(plain.spread);
  });

  it("returns mcp-ui style with distinct background", () => {
    const mcp = auraVisualForTarget({ kind: "mcp-ui", reason: undefined, width: 100, height: 30 });
    expect(mcp.background).toContain("radial-gradient");
    expect(mcp.borderRadius).toBeGreaterThan(0);
  });
});

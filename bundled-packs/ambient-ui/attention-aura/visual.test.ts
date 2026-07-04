import type { AttentionTarget } from "@charminal/sdk";
import { describe, expect, it } from "vitest";
import { auraBorderRadiusForTarget, auraVisualForTarget, targetOpacity } from "./visual";

const sampleTarget: AttentionTarget = {
  kind: "mouse",
  source: "mouse",
  rect: { x: 0, y: 0, width: 60, height: 60 },
  confidence: 1,
  priority: 4,
  timestamp: 0,
};

describe("targetOpacity", () => {
  it("null target で 0 を返す", () => {
    expect(targetOpacity(null)).toBe(0);
  });

  it("kind ごとの base opacity に confidence を掛けた値を返す", () => {
    const t: AttentionTarget = { ...sampleTarget, confidence: 0.5 };
    expect(targetOpacity(t)).toBeCloseTo(0.18, 2); // mouse base 0.36 * 0.5
  });

  it("confidence を [0, 1] にクランプする", () => {
    expect(targetOpacity({ ...sampleTarget, confidence: -1 })).toBe(0);
    expect(targetOpacity({ ...sampleTarget, confidence: 2 })).toBeCloseTo(0.36, 2);
  });

  it("approval-required reason で 1.18 倍の boost を適用する", () => {
    const t: AttentionTarget = {
      ...sampleTarget,
      kind: "terminal-region",
      confidence: 1,
      reason: "approval-required",
    };
    // terminal-region base 0.38 * 1.18 = 0.4484
    expect(targetOpacity(t)).toBeCloseTo(0.4484, 3);
  });

  it("error reason で 1.18 倍の boost を適用する", () => {
    const t: AttentionTarget = {
      ...sampleTarget,
      kind: "terminal-region",
      confidence: 1,
      reason: "error",
    };
    expect(targetOpacity(t)).toBeCloseTo(0.4484, 3);
  });

  it("diagnostic reason で 1.18 倍の boost を適用する", () => {
    const t: AttentionTarget = {
      ...sampleTarget,
      kind: "terminal-region",
      confidence: 1,
      reason: "diagnostic",
    };
    expect(targetOpacity(t)).toBeCloseTo(0.4484, 3);
  });

  it("file-link reason で 1.08 倍の boost を適用する", () => {
    const t: AttentionTarget = {
      ...sampleTarget,
      kind: "terminal-region",
      confidence: 1,
      reason: "file-link",
    };
    // terminal-region base 0.38 * 1.08 = 0.4104
    expect(targetOpacity(t)).toBeCloseTo(0.4104, 3);
  });

  it("その他の reason では boost なし (1.0 倍)", () => {
    const t: AttentionTarget = {
      ...sampleTarget,
      kind: "input-cursor",
      confidence: 1,
      reason: "typing",
    };
    // input-cursor base 0.42 * 1.0 = 0.42
    expect(targetOpacity(t)).toBeCloseTo(0.42, 3);
  });
});

describe("auraVisualForTarget", () => {
  it("borderRadius helper は auraVisualForTarget と同じ値を返す", () => {
    const cases = [
      { kind: "mouse", reason: undefined, width: 60, height: 60 },
      { kind: "input-cursor", reason: "typing", width: 8, height: 16 },
      { kind: "focused-dom", reason: undefined, width: 100, height: 40 },
      { kind: "mcp-ui", reason: undefined, width: 100, height: 30 },
      { kind: "terminal-region", reason: "tool-running", width: 200, height: 16 },
      { kind: "terminal-region", reason: "approval-required", width: 200, height: 16 },
      { kind: "terminal-region", reason: "error", width: 200, height: 16 },
      { kind: "terminal-region", reason: "file-link", width: 200, height: 16 },
    ];

    for (const input of cases) {
      expect(auraBorderRadiusForTarget(input)).toBe(auraVisualForTarget(input).borderRadius);
    }
  });

  it("mouse の visual を返す (デフォルト fallback)", () => {
    const v = auraVisualForTarget({ kind: "mouse", reason: undefined, width: 60, height: 60 });
    expect(v.blur).toBeGreaterThan(0);
    expect(v.spread).toBeGreaterThan(0);
    expect(v.background).toContain("radial-gradient");
    expect(v.boxShadow).toContain("0 0");
  });

  it("mouse の spread は 38", () => {
    const v = auraVisualForTarget({ kind: "mouse", reason: undefined, width: 60, height: 60 });
    expect(v.spread).toBe(38);
  });

  it("input-cursor の spread は 26 (v1 復元)", () => {
    const v = auraVisualForTarget({
      kind: "input-cursor",
      reason: undefined,
      width: 8,
      height: 16,
    });
    expect(v.spread).toBe(26);
  });

  it("input-cursor のデフォルトは mouse より spread が小さい", () => {
    const cursor = auraVisualForTarget({
      kind: "input-cursor",
      reason: "typing",
      width: 8,
      height: 16,
    });
    const mouse = auraVisualForTarget({ kind: "mouse", reason: undefined, width: 60, height: 60 });
    expect(cursor.spread).toBeLessThan(mouse.spread);
  });

  it("focused-dom の visual を返す (B6/B7 で producer 復元予定)", () => {
    const v = auraVisualForTarget({
      kind: "focused-dom",
      reason: undefined,
      width: 100,
      height: 40,
    });
    expect(v.spread).toBe(18);
    expect(v.blur).toBe(8);
    expect(v.background).toContain("radial-gradient");
  });

  it("mcp-ui の visual を返す (spread 28)", () => {
    const v = auraVisualForTarget({ kind: "mcp-ui", reason: undefined, width: 100, height: 30 });
    expect(v.spread).toBe(28);
    expect(v.background).toContain("radial-gradient");
    expect(v.borderRadius).toBeGreaterThan(0);
  });

  it("terminal-region/tool-reading は blue 系 (spread 24)", () => {
    const v = auraVisualForTarget({
      kind: "terminal-region",
      reason: "tool-reading",
      width: 200,
      height: 16,
    });
    expect(v.spread).toBe(24);
    expect(v.blur).toBe(10);
  });

  it("terminal-region/tool-writing は green 系 (spread 24)", () => {
    const v = auraVisualForTarget({
      kind: "terminal-region",
      reason: "tool-writing",
      width: 200,
      height: 16,
    });
    expect(v.spread).toBe(24);
    expect(v.blur).toBe(10);
    // green 成分を含む
    expect(v.background).toContain("232, 255, 218");
  });

  it("terminal-region/tool-running は最大 spread (34, blur 14)", () => {
    const v = auraVisualForTarget({
      kind: "terminal-region",
      reason: "tool-running",
      width: 200,
      height: 16,
    });
    expect(v.spread).toBe(34);
    expect(v.blur).toBe(14);
  });

  it("terminal-region/approval-required は golden (spread 30, blur 14)", () => {
    const v = auraVisualForTarget({
      kind: "terminal-region",
      reason: "approval-required",
      width: 200,
      height: 16,
    });
    expect(v.spread).toBe(30);
    expect(v.blur).toBe(14);
    // golden/orange 成分
    expect(v.background).toContain("255, 244, 216");
  });

  it("terminal-region/error は red 系 (spread 20, blur 12)", () => {
    const v = auraVisualForTarget({
      kind: "terminal-region",
      reason: "error",
      width: 200,
      height: 16,
    });
    expect(v.spread).toBe(20);
    expect(v.blur).toBe(12);
    expect(v.background).toContain("255, 142, 120");
  });

  it("terminal-region/diagnostic は red 系 (spread 20, blur 12)", () => {
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
    expect(diag.spread).toBe(20);
    // diagnostic は plain と同等以上の spread (同値は許容: plain も 20)
    expect(diag.spread).toBeGreaterThanOrEqual(plain.spread);
  });

  it("terminal-region/file-link は cyan compact (spread 12, blur 6)", () => {
    const v = auraVisualForTarget({
      kind: "terminal-region",
      reason: "file-link",
      width: 200,
      height: 16,
    });
    expect(v.spread).toBe(12);
    expect(v.blur).toBe(6);
  });

  it("terminal-region/search-match は cyan compact (spread 12, blur 6)", () => {
    const v = auraVisualForTarget({
      kind: "terminal-region",
      reason: "search-match",
      width: 200,
      height: 16,
    });
    expect(v.spread).toBe(12);
    expect(v.blur).toBe(6);
  });

  it("terminal-region default (reason なし) は modest な spread", () => {
    const v = auraVisualForTarget({
      kind: "terminal-region",
      reason: undefined,
      width: 200,
      height: 16,
    });
    expect(v.spread).toBe(20);
    expect(v.blur).toBe(10);
  });
});

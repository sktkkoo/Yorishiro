/**
 * Body primitive — unit tests for VRM-independent core logic.
 *
 * Tests ExpressionManager (weight budget), EyeSystem (idle + override),
 * BlinkSystem (blink timing), and utility functions.
 */

import { describe, expect, it } from "vitest";
import { BlinkSystem } from "./blink-system";
import { ExpressionManager, expressionTargetToName } from "./expression-manager";
import { EyeSystem, gazeTargetToAngles } from "./eye-system";

// ─── ExpressionManager ───────────────────────────────────

describe("ExpressionManager", () => {
  it("single expression: effective equals requested", () => {
    const mgr = new ExpressionManager();
    const id = mgr.addSlot("happy", 0.5);
    expect(mgr.getEffectiveWeight(id)).toBe(0.5);
  });

  it("two expressions under budget: no scale-down", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("happy", 0.3);
    const b = mgr.addSlot("sad", 0.4);
    expect(mgr.getEffectiveWeight(a)).toBe(0.3);
    expect(mgr.getEffectiveWeight(b)).toBe(0.4);
  });

  it("two expressions at exactly 1.0: no scale-down", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("happy", 0.6);
    const b = mgr.addSlot("sad", 0.4);
    expect(mgr.getEffectiveWeight(a)).toBe(0.6);
    expect(mgr.getEffectiveWeight(b)).toBe(0.4);
  });

  it("two expressions over budget: proportional scale-down", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("happy", 0.8);
    const b = mgr.addSlot("sad", 0.4);
    // total = 1.2, scale = 1/1.2
    expect(mgr.getEffectiveWeight(a)).toBeCloseTo(0.8 / 1.2);
    expect(mgr.getEffectiveWeight(b)).toBeCloseTo(0.4 / 1.2);
    // Sum should be exactly 1
    expect(mgr.getEffectiveWeight(a) + mgr.getEffectiveWeight(b)).toBeCloseTo(1.0);
  });

  it("three expressions over budget: proportional scale-down preserves ratios", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("happy", 0.5);
    const b = mgr.addSlot("sad", 0.5);
    const c = mgr.addSlot("surprised", 0.5);
    // total = 1.5, scale = 1/1.5 = 2/3
    expect(mgr.getEffectiveWeight(a)).toBeCloseTo(1 / 3);
    expect(mgr.getEffectiveWeight(b)).toBeCloseTo(1 / 3);
    expect(mgr.getEffectiveWeight(c)).toBeCloseTo(1 / 3);
  });

  it("removing a slot gives remaining expressions more budget", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("happy", 0.8);
    const b = mgr.addSlot("sad", 0.4);
    // Over budget: a = 0.8/1.2, b = 0.4/1.2
    expect(mgr.getEffectiveWeight(a)).toBeCloseTo(0.8 / 1.2);

    mgr.removeSlot(b);
    // Now only a at 0.8, under budget
    expect(mgr.getEffectiveWeight(a)).toBe(0.8);
    expect(mgr.getEffectiveWeight(b)).toBe(0); // removed
  });

  it("setWeight updates effective weights", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("happy", 0.3);
    expect(mgr.getEffectiveWeight(a)).toBe(0.3);

    mgr.setWeight(a, 0.7);
    expect(mgr.getEffectiveWeight(a)).toBe(0.7);
  });

  it("setWeight triggers budget recomputation", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("happy", 0.5);
    const b = mgr.addSlot("sad", 0.3);
    // total 0.8 — under budget
    expect(mgr.getEffectiveWeight(a)).toBe(0.5);

    mgr.setWeight(a, 0.9);
    // total 1.2 — over budget now
    expect(mgr.getEffectiveWeight(a)).toBeCloseTo(0.9 / 1.2);
    expect(mgr.getEffectiveWeight(b)).toBeCloseTo(0.3 / 1.2);
  });

  it("getResolved aggregates by expression name", () => {
    const mgr = new ExpressionManager();
    mgr.addSlot("happy", 0.3);
    mgr.addSlot("happy", 0.2); // same expression, two slots
    mgr.addSlot("sad", 0.1);

    const resolved = mgr.getResolved();
    expect(resolved.get("happy")).toBeCloseTo(0.5);
    expect(resolved.get("sad")).toBeCloseTo(0.1);
  });

  it("empty manager: getResolved returns empty map", () => {
    const mgr = new ExpressionManager();
    expect(mgr.getResolved().size).toBe(0);
  });

  it("zero weight slot does not cause division by zero", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("happy", 0);
    expect(mgr.getEffectiveWeight(a)).toBe(0);
    expect(mgr.size).toBe(1);
  });

  it("setWeight on nonexistent ID is a no-op", () => {
    const mgr = new ExpressionManager();
    mgr.setWeight(999, 0.5); // should not throw
    expect(mgr.size).toBe(0);
  });

  it("removeSlot on nonexistent ID is a no-op", () => {
    const mgr = new ExpressionManager();
    mgr.removeSlot(999); // should not throw
    expect(mgr.size).toBe(0);
  });
});

// ─── expressionTargetToName ──────────────────────────────

describe("expressionTargetToName", () => {
  it("maps mood preset", () => {
    expect(expressionTargetToName({ kind: "mood", preset: "happy" })).toBe("happy");
    expect(expressionTargetToName({ kind: "mood", preset: "sad" })).toBe("sad");
  });

  it("maps eye variant", () => {
    expect(expressionTargetToName({ kind: "eye", variant: "blink" })).toBe("blink");
    expect(expressionTargetToName({ kind: "eye", variant: "lookdown" })).toBe("lookdown");
  });

  it("maps lip phoneme", () => {
    expect(expressionTargetToName({ kind: "lip", phoneme: "aa" })).toBe("aa");
  });

  it("maps custom blendShapeName", () => {
    expect(expressionTargetToName({ kind: "custom", blendShapeName: "pout" })).toBe("pout");
  });
});

// ─── EyeSystem ───────────────────────────────────────────

describe("EyeSystem", () => {
  it("idle mode: output is within expected range", () => {
    const eye = new EyeSystem(() => 0.5);
    // Advance several seconds to trigger saccades
    for (let i = 0; i < 100; i++) eye.update(0.05);
    const out = eye.getOutput();
    expect(out.yaw).toBeGreaterThanOrEqual(-30);
    expect(out.yaw).toBeLessThanOrEqual(30);
    expect(out.pitch).toBeGreaterThanOrEqual(-25);
    expect(out.pitch).toBeLessThanOrEqual(25);
  });

  it("override: output matches override target", () => {
    const eye = new EyeSystem();
    eye.setOverride(15, -10);
    expect(eye.getOutput()).toEqual({ yaw: 15, pitch: -10 });
  });

  it("override pauses idle updates", () => {
    const eye = new EyeSystem(() => 0.5);
    // Get initial idle state
    for (let i = 0; i < 10; i++) eye.update(0.05);
    const beforeOverride = eye.getOutput();

    // Set override
    eye.setOverride(20, 5);
    expect(eye.getOutput()).toEqual({ yaw: 20, pitch: 5 });

    // Update several frames — idle should NOT advance
    for (let i = 0; i < 100; i++) eye.update(0.05);
    expect(eye.getOutput()).toEqual({ yaw: 20, pitch: 5 });

    // Release — should return to where idle was
    eye.releaseOverride(1); // first override ID is 1
    const afterRelease = eye.getOutput();
    // After release, idle resumes from paused state (same as beforeOverride)
    expect(afterRelease.yaw).toBeCloseTo(beforeOverride.yaw, 0);
    expect(afterRelease.pitch).toBeCloseTo(beforeOverride.pitch, 0);
  });

  it("new override replaces previous", () => {
    const eye = new EyeSystem();
    const id1 = eye.setOverride(10, 5);
    expect(eye.getOutput()).toEqual({ yaw: 10, pitch: 5 });

    const id2 = eye.setOverride(-15, 8);
    expect(eye.getOutput()).toEqual({ yaw: -15, pitch: 8 });
    expect(id2).not.toBe(id1);
  });

  it("stale override release has no effect", () => {
    const eye = new EyeSystem();
    const id1 = eye.setOverride(10, 5);
    eye.setOverride(-15, 8); // replaces id1

    eye.releaseOverride(id1); // stale — should be ignored
    expect(eye.getOutput()).toEqual({ yaw: -15, pitch: 8 });
    expect(eye.hasOverride).toBe(true);
  });

  it("hasOverride reflects state", () => {
    const eye = new EyeSystem();
    expect(eye.hasOverride).toBe(false);

    const id = eye.setOverride(0, 0);
    expect(eye.hasOverride).toBe(true);

    eye.releaseOverride(id);
    expect(eye.hasOverride).toBe(false);
  });
});

// ─── gazeTargetToAngles ──────────────────────────────────

describe("gazeTargetToAngles", () => {
  it("camera: looks straight ahead", () => {
    const out = gazeTargetToAngles({ kind: "camera" });
    expect(out.yaw).toBe(0);
    expect(out.pitch).toBe(0);
  });

  it("away: non-zero yaw", () => {
    const out = gazeTargetToAngles({ kind: "away" }, () => 0.8);
    expect(Math.abs(out.yaw)).toBeGreaterThan(10);
  });

  it("point: forward direction gives ~0 yaw", () => {
    const out = gazeTargetToAngles({ kind: "point", direction: { x: 0, y: 0, z: 1 } });
    expect(out.yaw).toBeCloseTo(0, 0);
    expect(out.pitch).toBeCloseTo(0, 0);
  });

  it("point: right direction gives positive yaw", () => {
    const out = gazeTargetToAngles({ kind: "point", direction: { x: 1, y: 0, z: 1 } });
    expect(out.yaw).toBeGreaterThan(0);
  });

  it("screen-element: approximated as downward gaze", () => {
    const out = gazeTargetToAngles({ kind: "screen-element", selector: ".terminal" });
    expect(out.pitch).toBeLessThan(0); // looking down
  });
});

// ─── BlinkSystem ─────────────────────────────────────────

describe("BlinkSystem", () => {
  it("starts with value 0", () => {
    const blink = new BlinkSystem();
    expect(blink.value).toBe(0);
  });

  it("eventually produces a blink (value reaches 1.0)", () => {
    const blink = new BlinkSystem(() => 0); // min random → shortest interval
    let maxValue = 0;
    // Run for 10 seconds of simulated time
    for (let i = 0; i < 600; i++) {
      const v = blink.update(1 / 60);
      if (v > maxValue) maxValue = v;
    }
    expect(maxValue).toBe(1.0);
  });

  it("returns to 0 after blink completes", () => {
    const blink = new BlinkSystem(() => 0);
    // Fast forward until blink starts and finishes
    for (let i = 0; i < 600; i++) blink.update(1 / 60);
    // After enough time, should be back at 0
    for (let i = 0; i < 120; i++) blink.update(1 / 60);
    // Should have returned to 0 at some point
    expect(blink.value).toBe(0);
  });

  it("suppress stops blink generation", () => {
    const blink = new BlinkSystem(() => 0);
    blink.suppress();
    // Run for several seconds
    for (let i = 0; i < 600; i++) blink.update(1 / 60);
    expect(blink.value).toBe(0);
  });

  it("resume after suppress restarts blink cycle", () => {
    const blink = new BlinkSystem(() => 0);
    blink.suppress();
    blink.resume();
    let maxValue = 0;
    for (let i = 0; i < 600; i++) {
      const v = blink.update(1 / 60);
      if (v > maxValue) maxValue = v;
    }
    expect(maxValue).toBe(1.0);
  });

  it("values stay in [0, 1] range", () => {
    const blink = new BlinkSystem();
    for (let i = 0; i < 3600; i++) {
      const v = blink.update(1 / 60);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

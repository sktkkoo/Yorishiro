import { describe, expect, it } from "vitest";
import { type MotionAxis, motionGain } from "./motion-gain";

const AXES: MotionAxis[] = ["head", "sway", "posture", "breathing"];

describe("motionGain", () => {
  it("intensity 1.0 は全軸で gain 1.0（default 不変の保証）", () => {
    for (const axis of AXES) {
      expect(motionGain(1.0, axis)).toBe(1.0);
    }
  });

  it("intensity 0 は全軸で 0（静止方向）", () => {
    for (const axis of AXES) {
      expect(motionGain(0, axis)).toBe(0);
    }
  });

  it("intensity が上がると各軸 gain が単調増加する", () => {
    for (const axis of AXES) {
      expect(motionGain(2, axis)).toBeGreaterThan(motionGain(1, axis));
      expect(motionGain(3, axis)).toBeGreaterThan(motionGain(2, axis));
    }
  });

  it("同じ intensity では head > sway > posture > breathing の順に大きく効く", () => {
    expect(motionGain(2, "head")).toBeGreaterThan(motionGain(2, "sway"));
    expect(motionGain(2, "sway")).toBeGreaterThan(motionGain(2, "posture"));
    expect(motionGain(2, "posture")).toBeGreaterThan(motionGain(2, "breathing"));
  });

  it("不正値（NaN / 負）は 1.0 にフォールバック / 0 で clamp", () => {
    expect(motionGain(Number.NaN, "head")).toBe(1.0);
    expect(motionGain(-5, "head")).toBe(0);
  });
});

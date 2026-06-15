import { describe, expect, it } from "vitest";
import { type MotionAxis, motionGain, springParams } from "./motion-gain";

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

describe("springParams", () => {
  it("default intensity(1.0) で中間的なパラメータを返す", () => {
    const p = springParams(1.0);
    expect(p.spineOmega).toBeGreaterThan(3);
    expect(p.spineOmega).toBeLessThan(10);
    expect(p.spineZeta).toBeGreaterThan(0.5);
    expect(p.spineZeta).toBeLessThan(1.0);
  });

  it("高 intensity で omega が上がり zeta が下がり interval が短くなる", () => {
    const low = springParams(0.5);
    const high = springParams(2.5);
    expect(high.spineOmega).toBeGreaterThan(low.spineOmega);
    expect(high.spineZeta).toBeLessThan(low.spineZeta);
    expect(high.headOmega).toBeGreaterThan(low.headOmega);
    expect(high.headZeta).toBeLessThan(low.headZeta);
    expect(high.headTimerScale).toBeLessThan(low.headTimerScale);
  });

  it("omega と zeta が安全範囲に clamp される", () => {
    const extreme = springParams(3.0);
    expect(extreme.spineOmega).toBeLessThanOrEqual(15);
    expect(extreme.spineZeta).toBeGreaterThanOrEqual(0.2);
    const zero = springParams(0);
    expect(zero.spineOmega).toBeGreaterThanOrEqual(1);
    expect(zero.spineZeta).toBeLessThanOrEqual(1.2);
  });
});

import { describe, expect, it } from "vitest";
import {
  beatAccentRate,
  type MotionAxis,
  motionGain,
  sampleSkewedInterval,
  springParams,
} from "./motion-gain";

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

describe("beatAccentRate", () => {
  it("intensity 1.0 以下でほぼゼロに近い", () => {
    expect(beatAccentRate(0)).toBeLessThan(0.5);
    expect(beatAccentRate(1.0)).toBeLessThan(0.5);
  });

  it("intensity 2.5 で活発(5+ beats/min)", () => {
    expect(beatAccentRate(2.5)).toBeGreaterThan(5);
  });

  it("単調増加する", () => {
    expect(beatAccentRate(2.5)).toBeGreaterThan(beatAccentRate(2.0));
  });
});

describe("sampleSkewedInterval", () => {
  it("平均がほぼ mean に保たれる", () => {
    let s = 12345;
    const rng = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    let sum = 0;
    const n = 5000;
    for (let i = 0; i < n; i++) sum += sampleSkewedInterval(2.0, rng);
    const mean = sum / n;
    expect(mean).toBeGreaterThan(1.6);
    expect(mean).toBeLessThan(2.4);
  });

  it("mean*3 を超えない / mean*0.2 を下回らない", () => {
    const hi = sampleSkewedInterval(2.0, () => 0.9999);
    const lo = sampleSkewedInterval(2.0, () => 0.0001);
    expect(hi).toBeLessThanOrEqual(6.0001);
    expect(lo).toBeGreaterThanOrEqual(0.3999);
  });
});

describe("springParams zeta floor", () => {
  it("高 intensity でも ζ は 0.5 以上(おもちゃ感の是正)", () => {
    const p = springParams(3.0);
    expect(p.spineZeta).toBeGreaterThanOrEqual(0.5);
    expect(p.headZeta).toBeGreaterThanOrEqual(0.5);
  });
});

import { describe, expect, it } from "vitest";
import { automaticPerformanceWeight, calibratedMotionIntensity } from "./motion-intensity";

describe("automatic authored performance strength", () => {
  it.each([
    0.21, 0.45, 0.6, 0.85, 1,
  ])("maps Standard %s to full authored Lively/Over", (standard) => {
    expect(automaticPerformanceWeight(0, standard)).toBe(0);
    expect(automaticPerformanceWeight(0.5, standard)).toBe(standard * 0.5);
    expect(automaticPerformanceWeight(1, standard)).toBe(standard);
    expect(automaticPerformanceWeight(1.5, standard)).toBeCloseTo((standard + 1) / 2);
    expect(automaticPerformanceWeight(2, standard)).toBe(1);
    expect(automaticPerformanceWeight(3, standard)).toBe(1);
  });

  it("retains a reviewed ceiling and does not extrapolate or invert the curve", () => {
    let previous = 0;
    for (let step = 0; step <= 300; step++) {
      const weight = automaticPerformanceWeight(step / 100, 0.6, 0.8);
      expect(weight).toBeGreaterThanOrEqual(previous);
      expect(weight).toBeLessThanOrEqual(0.8);
      previous = weight;
    }
    expect(automaticPerformanceWeight(2, 0.6, 0.8)).toBe(0.8);
    expect(automaticPerformanceWeight(3, 1, 0.8)).toBe(0.8);
    expect(automaticPerformanceWeight(Number.NaN, 0.6)).toBe(0.6);
    expect(automaticPerformanceWeight(-1, 0.6)).toBe(0);
    expect(automaticPerformanceWeight(10, 0.6)).toBe(1);
  });
});

describe("public motion intensity calibration", () => {
  it("makes Normal quieter and moves the former Normal to Lively", () => {
    expect(calibratedMotionIntensity(0.5)).toBe(0.25);
    expect(calibratedMotionIntensity(1)).toBe(0.5);
    expect(calibratedMotionIntensity(2)).toBe(1);
    expect(calibratedMotionIntensity(3)).toBe(3);
  });

  it("preserves zero, stays bounded and increases continuously across the full slider", () => {
    expect(calibratedMotionIntensity(0)).toBe(0);
    let previous = 0;
    for (let step = 1; step <= 300; step++) {
      const strength = calibratedMotionIntensity(step / 100);
      expect(strength).toBeGreaterThan(previous);
      expect(strength - previous).toBeLessThanOrEqual(0.020000000001);
      expect(strength).toBeLessThanOrEqual(3);
      previous = strength;
    }
  });

  it.each([
    [-1, 0],
    [9, 3],
    [Number.NaN, 0.5],
    [Number.POSITIVE_INFINITY, 0.5],
  ])("handles invalid or out-of-range setting %s as strength %s", (setting, expected) => {
    expect(calibratedMotionIntensity(setting)).toBe(expected);
  });
});

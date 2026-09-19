import { describe, expect, it } from "vitest";
import { calibratedMotionIntensity } from "./motion-intensity";

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

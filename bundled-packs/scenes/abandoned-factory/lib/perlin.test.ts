import { describe, expect, it } from "vitest";
import { perlin1d } from "./perlin";

describe("perlin1d", () => {
  it("returns deterministic value for same input", () => {
    expect(perlin1d(1.5)).toBe(perlin1d(1.5));
  });
  it("returns smooth value in [-1, 1] range", () => {
    for (let t = 0; t < 100; t += 0.13) {
      const v = perlin1d(t);
      expect(v).toBeGreaterThanOrEqual(-1.01);
      expect(v).toBeLessThanOrEqual(1.01);
    }
  });
  it("returns near-continuous values across small steps", () => {
    const a = perlin1d(2.0);
    const b = perlin1d(2.001);
    expect(Math.abs(a - b)).toBeLessThan(0.05);
  });
});

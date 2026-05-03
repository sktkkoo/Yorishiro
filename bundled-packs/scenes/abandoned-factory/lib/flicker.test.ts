import { describe, expect, it } from "vitest";
import { computeCrtFlicker, computeLanternFlicker } from "./flicker";

describe("computeLanternFlicker", () => {
  it("returns positive intensity (lantern is on)", () => {
    for (let t = 0; t < 100; t += 0.1) {
      const v = computeLanternFlicker(t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(2.5);
    }
  });
  it("returns deterministic value for same time", () => {
    expect(computeLanternFlicker(5.5)).toBe(computeLanternFlicker(5.5));
  });
  it("base intensity is around 1.4 most of the time", () => {
    let sum = 0;
    let count = 0;
    for (let t = 0; t < 50; t += 0.1) {
      sum += computeLanternFlicker(t);
      count += 1;
    }
    const avg = sum / count;
    expect(avg).toBeGreaterThan(1.0);
    expect(avg).toBeLessThan(1.7);
  });
});

describe("computeCrtFlicker", () => {
  it("returns intensity around 0.5", () => {
    for (let t = 0; t < 100; t += 0.1) {
      const v = computeCrtFlicker(t);
      expect(v).toBeGreaterThan(0.2);
      expect(v).toBeLessThan(0.8);
    }
  });
  it("varies more rapidly than lantern (high-frequency component)", () => {
    const a = computeCrtFlicker(1.0);
    const b = computeCrtFlicker(1.05);
    expect(Math.abs(a - b)).toBeGreaterThan(0.001);
  });
});

import { describe, expect, it } from "vitest";
import { computeShakeOffset } from "./shake";

// Deterministic RNG for test reproducibility — returns values in [0, 1).
const seeded = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
};

describe("computeShakeOffset", () => {
  it("returns zero offset at elapsed ≥ durationMs", () => {
    const rand = seeded(1);
    expect(computeShakeOffset(300, 300, 1.0, rand)).toEqual({ dx: 0, dy: 0 });
    expect(computeShakeOffset(999, 300, 1.0, rand)).toEqual({ dx: 0, dy: 0 });
  });

  it("returns non-zero offset while within duration", () => {
    const rand = seeded(1);
    const offset = computeShakeOffset(50, 300, 1.0, rand);
    expect(offset.dx).not.toBe(0);
    expect(offset.dy).not.toBe(0);
  });

  it("decays: magnitude at later time is smaller than at earlier time", () => {
    const early = computeShakeOffset(30, 300, 1.0, seeded(42));
    const late = computeShakeOffset(270, 300, 1.0, seeded(42));
    const earlyMag = Math.abs(early.dx) + Math.abs(early.dy);
    const lateMag = Math.abs(late.dx) + Math.abs(late.dy);
    expect(lateMag).toBeLessThan(earlyMag);
  });

  it("scales with intensity", () => {
    const low = computeShakeOffset(30, 300, 0.2, seeded(42));
    const high = computeShakeOffset(30, 300, 1.0, seeded(42));
    const lowMag = Math.abs(low.dx) + Math.abs(low.dy);
    const highMag = Math.abs(high.dx) + Math.abs(high.dy);
    expect(highMag).toBeGreaterThan(lowMag);
  });

  it("returns zero offset when intensity is 0", () => {
    const offset = computeShakeOffset(30, 300, 0, seeded(1));
    expect(offset).toEqual({ dx: 0, dy: 0 });
  });
});

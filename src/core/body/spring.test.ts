import { describe, expect, it } from "vitest";
import { Spring1D } from "./spring";

const DT = 1 / 60;

describe("Spring1D", () => {
  it("target に収束する", () => {
    const s = new Spring1D({ omega: 6, zeta: 0.7 });
    for (let i = 0; i < 300; i++) s.update(DT, 1.0);
    expect(s.pos).toBeCloseTo(1.0, 3);
    expect(s.vel).toBeCloseTo(0, 2);
  });

  it("underdamped（zeta < 1）で overshoot が出る", () => {
    const s = new Spring1D({ omega: 8, zeta: 0.3 });
    let maxPos = 0;
    for (let i = 0; i < 300; i++) {
      s.update(DT, 1.0);
      maxPos = Math.max(maxPos, s.pos);
    }
    expect(maxPos).toBeGreaterThan(1.1);
    expect(s.pos).toBeCloseTo(1.0, 2);
  });

  it("critically damped（zeta = 1）で overshoot しない", () => {
    const s = new Spring1D({ omega: 6, zeta: 1.0 });
    for (let i = 0; i < 300; i++) {
      s.update(DT, 1.0);
      expect(s.pos).toBeLessThanOrEqual(1.001);
    }
    expect(s.pos).toBeCloseTo(1.0, 2);
  });

  it("大 delta（0.5 秒）で発散しない", () => {
    const s = new Spring1D({ omega: 10, zeta: 0.3 });
    for (let i = 0; i < 20; i++) s.update(0.5, 1.0);
    expect(Number.isFinite(s.pos)).toBe(true);
    expect(Math.abs(s.pos)).toBeLessThan(5);
  });

  it("初期値から開始する", () => {
    const s = new Spring1D({ omega: 6, zeta: 0.7, initialPos: 0.5 });
    expect(s.pos).toBe(0.5);
    expect(s.vel).toBe(0);
  });

  it("パラメータを動的に変更できる", () => {
    const s = new Spring1D({ omega: 6, zeta: 0.7 });
    for (let i = 0; i < 60; i++) s.update(DT, 1.0);
    const posBeforeChange = s.pos;
    s.setParams(12, 0.3);
    for (let i = 0; i < 60; i++) s.update(DT, 1.0);
    expect(s.pos).toBeCloseTo(1.0, 2);
    expect(posBeforeChange).not.toBeCloseTo(1.0, 2);
  });

  it("target が変わると snap → settle する", () => {
    const s = new Spring1D({ omega: 8, zeta: 0.5 });
    for (let i = 0; i < 300; i++) s.update(DT, 0);
    expect(s.pos).toBeCloseTo(0, 3);
    const velocities: number[] = [];
    let prev = s.pos;
    for (let i = 0; i < 120; i++) {
      s.update(DT, 1.0);
      velocities.push(Math.abs(s.pos - prev) / DT);
      prev = s.pos;
    }
    const peakVelocity = Math.max(...velocities);
    const finalVelocity = velocities[velocities.length - 1];
    expect(peakVelocity).toBeGreaterThan(finalVelocity * 5);
  });
});

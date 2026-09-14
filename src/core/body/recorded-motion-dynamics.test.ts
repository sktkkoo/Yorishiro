import { describe, expect, it, vi } from "vitest";
import { RecordedMotionDynamics } from "./recorded-motion-dynamics";

function advance(
  dynamics: RecordedMotionDynamics,
  milliseconds: number,
  intensity = 1,
  eligible = true,
  step = 100,
) {
  let result = dynamics.update(0, intensity, eligible);
  for (let remaining = milliseconds; remaining > 0; remaining -= step) {
    result = dynamics.update(Math.min(step, remaining), intensity, eligible);
  }
  return result;
}

describe("RecordedMotionDynamics", () => {
  it("provides cold quiet gains without advancing time and reuses its output", () => {
    const random = vi.fn(() => 0.5);
    const dynamics = new RecordedMotionDynamics({ random });
    const output = dynamics.update(0, 1, true);
    expect(output).toEqual({ torso: 0.18, head: 0.06 });
    expect(dynamics.update(0, 2, true)).toBe(output);
    expect(output.torso).toBeCloseTo(0.415);
    expect(output.head).toBeCloseTo(0.255);
    expect(dynamics.update(0, 3, true)).toEqual({ torso: expect.closeTo(0.65, 10), head: 0.45 });
    expect(dynamics.update(0, 0.5, true)).toEqual({ torso: 0.09, head: 0.03 });
    expect(dynamics.update(0, 0, true)).toEqual({ torso: 0, head: 0 });
    expect(random).toHaveBeenCalledOnce();
  });

  it.each([0, 0.5, 1])("waits 45–90 eligible seconds at Normal with random %s", (random) => {
    const dynamics = new RecordedMotionDynamics({ random: () => random });
    expect(advance(dynamics, 45_000 + random * 45_000)).toEqual({ torso: 0.18, head: 0.06 });
    expect(advance(dynamics, 1_000).torso).toBeCloseTo(0.29);
    expect(advance(dynamics, 1_000)).toEqual({ torso: 0.4, head: 0.35 });
  });

  it.each([0, 1])("waits 20–40 seconds at Over and bounds the accent to 8–10 seconds", (random) => {
    const dynamics = new RecordedMotionDynamics({ random: () => random });
    advance(dynamics, 20_000 + random * 20_000, 3);
    expect(advance(dynamics, 2_000, 3)).toEqual({ torso: 1, head: 1 });
    expect(advance(dynamics, 4_000 + random * 2_000, 3)).toEqual({ torso: 1, head: 1 });
    const returning = { ...advance(dynamics, 1_000, 3) };
    expect(returning.torso).toBeCloseTo(0.825);
    expect(returning.head).toBeCloseTo(0.725);
    expect(advance(dynamics, 1_000, 3)).toEqual({ torso: expect.closeTo(0.65, 10), head: 0.45 });
    expect(advance(dynamics, 19_000, 3)).toEqual({ torso: expect.closeTo(0.65, 10), head: 0.45 });
  });

  it("spends no quiet wait while ineligible and releases an accent without restarting it", () => {
    const random = vi.fn(() => 0);
    const dynamics = new RecordedMotionDynamics({ random });
    advance(dynamics, 20_000);
    advance(dynamics, 300_000, 1, false);
    expect(advance(dynamics, 25_000)).toEqual({ torso: 0.18, head: 0.06 });
    expect(advance(dynamics, 2_000)).toEqual({ torso: 0.4, head: 0.35 });
    expect(dynamics.update(0, 1, false)).toEqual({ torso: 0.4, head: 0.35 });
    expect(advance(dynamics, 1_000, 1, false).torso).toBeCloseTo(0.29);
    // Even immediate re-entry finishes the same release, then requires a new wait.
    expect(advance(dynamics, 1_000)).toEqual({ torso: 0.18, head: 0.06 });
    advance(dynamics, 300_000, 1, false);
    expect(random).toHaveBeenCalledTimes(3);
    expect(advance(dynamics, 44_000)).toEqual({ torso: 0.18, head: 0.06 });
  });

  it("pauses both wait and active episode at zero, without consuming random choices", () => {
    const random = vi.fn(() => 0);
    const dynamics = new RecordedMotionDynamics({ random });
    advance(dynamics, 20_000);
    expect(advance(dynamics, 300_000, 0)).toEqual({ torso: 0, head: 0 });
    expect(random).toHaveBeenCalledOnce();
    advance(dynamics, 25_000);
    const rising = { ...advance(dynamics, 1_000) };
    expect(advance(dynamics, 300_000, 0, false)).toEqual({ torso: 0, head: 0 });
    expect(dynamics.update(0, 1, true)).toEqual(rising);
    expect(random).toHaveBeenCalledTimes(2);
    expect(advance(dynamics, 1_000)).toEqual({ torso: 0.4, head: 0.35 });
  });

  it("interpolates cadence and amplitude while retaining wait progress across level changes", () => {
    const dynamics = new RecordedMotionDynamics({ random: () => 0 });
    advance(dynamics, 22_500);
    expect(dynamics.update(0, 3, true)).toEqual({ torso: expect.closeTo(0.65, 10), head: 0.45 });
    expect(advance(dynamics, 9_900, 3)).toEqual({ torso: expect.closeTo(0.65, 10), head: 0.45 });
    advance(dynamics, 100, 3);
    expect(advance(dynamics, 2_000, 2).torso).toBeCloseTo(0.7);
    expect(dynamics.update(0, 2, true).head).toBeCloseTo(0.675);
  });

  it("uses smooth finite ramps with the same result at different frame cadences", () => {
    const a = new RecordedMotionDynamics({ random: () => 0.5 });
    const b = new RecordedMotionDynamics({ random: () => 0.5 });
    advance(a, 68_500, 1, true, 100);
    advance(b, 68_500, 1, true, 20);
    expect(a.update(0, 1, true).torso).toBeCloseTo(b.update(0, 1, true).torso, 9);
    const c = new RecordedMotionDynamics({ random: () => 0 });
    advance(c, 45_000);
    const start = { ...c.update(0, 1, true) };
    const first = c.update(1_000 / 60, 1, true);
    expect(first.head - start.head).toBeLessThan(0.00001);
    expect(first.head).toBeGreaterThan(start.head);
  });

  it("ignores invalid elapsed time and avoids catching up after a long suspension", () => {
    const random = vi.fn(() => Number.NaN);
    const dynamics = new RecordedMotionDynamics({ random });
    for (const delta of [-1, NaN, Infinity]) dynamics.update(delta, 1, true);
    dynamics.update(600_000, 1, true);
    expect(advance(dynamics, 66_000)).toEqual({ torso: 0.18, head: 0.06 });
    expect(random).toHaveBeenCalledOnce();
    expect(dynamics.update(0, NaN, false)).toEqual({ torso: 0.18, head: 0.06 });
    expect(dynamics.update(0, -1, false)).toEqual({ torso: 0, head: 0 });
  });
});

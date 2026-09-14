import { describe, expect, it } from "vitest";
import { RenderCadence } from "./render-cadence";

function jitteredFrames(refreshHz: number, seconds = 60): number[] {
  return Array.from(
    { length: refreshHz * seconds + 1 },
    (_, index) => (index * 1000) / refreshHz + 0.9 * Math.sin(index * 1.73),
  );
}

describe("RenderCadence", () => {
  it("retains quiet 30fps cadence under sub-millisecond RAF jitter instead of dropping to 25fps", () => {
    const timestamps = jitteredFrames(60);
    const cadence = new RenderCadence();
    const rendered = timestamps.filter((time) => cadence.takeFrame(time, false));
    expect(rendered).toHaveLength(1801);
    expect(
      Math.max(...rendered.slice(1).map((time, index) => time - rendered[index])),
    ).toBeLessThan(36);
    // Regression witness for restarting the timer from the delayed frame.
    let oldLast = -Infinity;
    const oldFrames = timestamps.filter((time) => {
      if (time - oldLast < 1000 / 30 - 0.5) return false;
      oldLast = time;
      return true;
    });
    expect(oldFrames).toHaveLength(1501);
  });

  it.each([60, 120])("presents recorded performance at 60fps on a %sHz display", (refreshHz) => {
    const cadence = new RenderCadence();
    const rendered = jitteredFrames(refreshHz).filter((time) => cadence.takeFrame(time, true));
    expect(rendered).toHaveLength(3601);
    expect(
      Math.max(...rendered.slice(1).map((time, index) => time - rendered[index])),
    ).toBeLessThan(19);
  });

  it("skips suspended time and never emits a catch-up burst", () => {
    const cadence = new RenderCadence();
    expect(cadence.takeFrame(0, true)).toBe(true);
    expect(cadence.takeFrame(600_000, true)).toBe(true);
    for (let i = 0; i < 10; i++) expect(cadence.takeFrame(600_000, true)).toBe(false);
    expect(cadence.takeFrame(600_000 + 1000 / 60, true)).toBe(true);
  });

  it("forces resize redraws without discarding the next regular deadline", () => {
    const cadence = new RenderCadence();
    expect(cadence.takeFrame(0, false)).toBe(true);
    expect(cadence.takeFrame(15, false)).toBe(false);
    expect(cadence.takeFrame(15, false, true)).toBe(true);
    expect(cadence.takeFrame(1000 / 30, false)).toBe(true);
  });

  it("switches rates and resumes visibility without inheriting stale deadlines", () => {
    const cadence = new RenderCadence();
    expect(cadence.takeFrame(0, false)).toBe(true);
    expect(cadence.takeFrame(10, true)).toBe(true);
    expect(cadence.takeFrame(10 + 1000 / 60, true)).toBe(true);
    expect(cadence.takeFrame(30, false)).toBe(true);
    expect(cadence.takeFrame(50, false)).toBe(false);
    expect(cadence.takeFrame(30 + 1000 / 30, false)).toBe(true);
    cadence.reset();
    expect(cadence.takeFrame(5, false)).toBe(true);
    expect(cadence.takeFrame(Number.NaN, true)).toBe(false);
  });
});

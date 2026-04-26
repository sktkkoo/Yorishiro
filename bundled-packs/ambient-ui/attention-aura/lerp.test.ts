import { describe, expect, it } from "vitest";
import { fadeOutOpacity, isConverged, lerp, lerpView } from "./lerp";

describe("lerp", () => {
  it("interpolates linearly between current and target", () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
  });
});

describe("lerpView", () => {
  it("interpolates all rect fields plus opacity", () => {
    const next = lerpView(
      { x: 0, y: 0, width: 0, height: 0, opacity: 0 },
      { x: 100, y: 50, width: 80, height: 20, opacity: 0.4 },
      0.5,
    );
    expect(next.x).toBe(50);
    expect(next.y).toBe(25);
    expect(next.width).toBe(40);
    expect(next.height).toBe(10);
    expect(next.opacity).toBeCloseTo(0.2);
  });
});

describe("isConverged", () => {
  it("returns true when current is within epsilon of target on all fields", () => {
    expect(
      isConverged(
        { x: 100, y: 50, width: 80, height: 20, opacity: 0.4 },
        { x: 100.01, y: 50.01, width: 80, height: 20, opacity: 0.4001 },
      ),
    ).toBe(true);
  });

  it("returns false when any field is far from target", () => {
    expect(
      isConverged(
        { x: 100, y: 50, width: 80, height: 20, opacity: 0.4 },
        { x: 200, y: 50, width: 80, height: 20, opacity: 0.4 },
      ),
    ).toBe(false);
  });
});

describe("fadeOutOpacity", () => {
  it("decays linearly from startOpacity to 0 over fadeDurationS", () => {
    expect(fadeOutOpacity({ startOpacity: 0.4, elapsedS: 0 }, 2)).toBeCloseTo(0.4);
    expect(fadeOutOpacity({ startOpacity: 0.4, elapsedS: 1 }, 2)).toBeCloseTo(0.2);
    expect(fadeOutOpacity({ startOpacity: 0.4, elapsedS: 2 }, 2)).toBe(0);
  });

  it("clamps to 0 when elapsed exceeds duration", () => {
    expect(fadeOutOpacity({ startOpacity: 0.4, elapsedS: 5 }, 2)).toBe(0);
  });
});

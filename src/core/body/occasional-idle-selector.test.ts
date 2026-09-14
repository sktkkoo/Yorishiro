import { describe, expect, it, vi } from "vitest";
import {
  OCCASIONAL_IDLE_ANIMATIONS,
  selectOccasionalIdleAnimation,
} from "./occasional-idle-selector";

const [survey, stretch] = OCCASIONAL_IDLE_ANIMATIONS;

describe("rare idle selection", () => {
  it("alternates compatible performances even when the random stream repeats", () => {
    const select = (previous: string | null) =>
      selectOccasionalIdleAnimation({
        available: new Set(OCCASIONAL_IDLE_ANIMATIONS),
        previous,
        canPlay: () => true,
        random: () => 0,
      });
    expect(select(null)).toBe(survey);
    expect(select(survey)).toBe(stretch);
    expect(select(stretch)).toBe(survey);
  });

  it("keeps an installed compatible fallback instead of forcing variety through a bad seam", () => {
    const canPlay = vi.fn((animation: string) => animation === survey);
    expect(
      selectOccasionalIdleAnimation({
        available: new Set(OCCASIONAL_IDLE_ANIMATIONS),
        previous: survey,
        canPlay,
        random: () => 1,
      }),
    ).toBe(survey);
    expect(canPlay).toHaveBeenCalledWith(stretch);
  });

  it("does not evaluate missing assets or play an incompatible entry", () => {
    const canPlay = vi.fn(() => false);
    expect(
      selectOccasionalIdleAnimation({
        available: new Set([stretch]),
        previous: null,
        canPlay,
        random: () => 0,
      }),
    ).toBeNull();
    expect(canPlay).toHaveBeenCalledExactlyOnceWith(stretch);
  });
});

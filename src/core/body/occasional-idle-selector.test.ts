import { describe, expect, it, vi } from "vitest";
import {
  OCCASIONAL_IDLE_ANIMATIONS,
  selectOccasionalIdleAnimation,
} from "./occasional-idle-selector";

const stretch = "/animations/mixamo/Warrior Stretch.vrma";

describe("rare idle selection", () => {
  it("excludes the raised-hand survey and selects the compatible stretch", () => {
    expect(OCCASIONAL_IDLE_ANIMATIONS).not.toContain("/animations/recorded-idle/survey.vrma");
    expect(
      selectOccasionalIdleAnimation({
        available: new Set(OCCASIONAL_IDLE_ANIMATIONS),
        previous: stretch,
        canPlay: () => true,
        random: () => 0,
      }),
    ).toBe(stretch);
  });

  it("does not play an incompatible entry", () => {
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

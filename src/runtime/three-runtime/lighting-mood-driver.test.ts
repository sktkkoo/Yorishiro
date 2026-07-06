import { Color } from "three";
import { describe, expect, it } from "vitest";
import type { LightingMood } from "../workspace-attention";
import { computeMoodLightTarget } from "./lighting-mood-driver";

const controls = {
  brightnessGain: 0.5,
  warmthGain: 0.25,
  lerpSpeed: 1,
};

describe("computeMoodLightTarget", () => {
  it("brightness を baseline 比の相対変調として clamp する", () => {
    const target = computeMoodLightTarget(
      { intensity: 2, color: new Color("#ffffff") },
      { tone: "waiting", warmth: 0.5, brightness: 1 },
      true,
      controls,
    );

    expect(target.intensity).toBe(2.5);
  });

  it("色温度方向へ tint し、hue 回転のような絶対色上書きはしない", () => {
    const baseline = new Color("#808080");
    const warm = computeMoodLightTarget(
      { intensity: 1, color: baseline },
      { tone: "waiting", warmth: 1, brightness: 0.5 },
      true,
      controls,
    );
    const cool = computeMoodLightTarget(
      { intensity: 1, color: baseline },
      { tone: "failed", warmth: 0, brightness: 0.5 },
      true,
      controls,
    );

    expect(warm.color.r).toBeGreaterThan(baseline.r);
    expect(cool.color.b).toBeGreaterThan(baseline.b);
  });

  it("settings off 相当では neutral 固定にする", () => {
    const baseline = { intensity: 1.2, color: new Color("#8090a0") };
    const mood: LightingMood = { tone: "failed", warmth: 0, brightness: 0 };
    const target = computeMoodLightTarget(baseline, mood, false, controls);

    expect(target.intensity).toBe(1.2);
    expect(target.color.getHexString()).toBe(baseline.color.getHexString());
  });
});

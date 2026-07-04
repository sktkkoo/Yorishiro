import { describe, expect, it } from "vitest";
import {
  ATTENTION_CUE_DURATION_SECONDS,
  ATTENTION_CUE_PULSE_DURATION_SECONDS,
  computeAttentionCueLightIntensity,
} from "./attention-cue-envelope";

describe("computeAttentionCueLightIntensity", () => {
  it("keeps pulse intensity bounded and fade-in/out shaped", () => {
    const start = computeAttentionCueLightIntensity(0);
    const rising = computeAttentionCueLightIntensity(ATTENTION_CUE_PULSE_DURATION_SECONDS * 0.25);
    const firstPeak = computeAttentionCueLightIntensity(ATTENTION_CUE_PULSE_DURATION_SECONDS * 0.5);
    const falling = computeAttentionCueLightIntensity(ATTENTION_CUE_PULSE_DURATION_SECONDS * 0.75);
    const betweenPulses = computeAttentionCueLightIntensity(ATTENTION_CUE_PULSE_DURATION_SECONDS);
    const secondPeak = computeAttentionCueLightIntensity(
      ATTENTION_CUE_PULSE_DURATION_SECONDS * 1.5,
    );
    const end = computeAttentionCueLightIntensity(ATTENTION_CUE_DURATION_SECONDS);

    expect(start).toEqual({ ambient: 0, point: 0, spot: 0 });
    expect(rising.spot).toBeGreaterThan(start.spot);
    expect(firstPeak.spot).toBeGreaterThan(rising.spot);
    expect(falling.spot).toBeCloseTo(rising.spot);
    expect(betweenPulses).toEqual({ ambient: 0, point: 0, spot: 0 });
    expect(secondPeak.ambient).toBeCloseTo(firstPeak.ambient);
    expect(secondPeak.point).toBeCloseTo(firstPeak.point);
    expect(secondPeak.spot).toBeCloseTo(firstPeak.spot);
    expect(end).toEqual({ ambient: 0, point: 0, spot: 0 });
    expect(firstPeak.ambient).toBeCloseTo(0.06);
    expect(firstPeak.point).toBeCloseTo(0.55);
    expect(firstPeak.spot).toBeCloseTo(0.65);
  });
});

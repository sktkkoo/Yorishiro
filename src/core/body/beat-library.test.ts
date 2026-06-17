import { describe, expect, it } from "vitest";
import { cognitiveAversion, defaultProfiles, microNod } from "./beat-library";

describe("beat library", () => {
  it("5 state すべてに profile を持つ", () => {
    expect(Object.keys(defaultProfiles).sort()).toEqual([
      "idle",
      "reading",
      "running",
      "thinking",
      "writing",
    ]);
  });

  it("thinking profile に cognitive aversion を含む", () => {
    expect(defaultProfiles.thinking.beats.map((beat) => beat.name)).toContain("cognitive-aversion");
    expect(cognitiveAversion.keyframes[0]?.pose.gaze?.durationS).toBeGreaterThanOrEqual(3);
  });

  it("microNod は逆溜め anticipation を持つ", () => {
    const first = microNod.keyframes[0]?.pose.spine?.x;
    const key = microNod.keyframes[1]?.pose.spine?.x;
    expect(first).toBeGreaterThan(0);
    expect(key).toBeLessThan(0);
  });
});

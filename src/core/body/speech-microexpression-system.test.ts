import { describe, expect, it, vi } from "vitest";
import type { MouthValues } from "../voice/mouth-values";
import { SpeechMicroexpressionSystem } from "./speech-microexpression-system";

const SILENCE: MouthValues = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };

function mouth(volume: number): MouthValues {
  return { aa: volume, ih: 0, ou: 0, ee: 0, oh: 0 };
}

function createSystem(random: () => number = () => 0): SpeechMicroexpressionSystem {
  const system = new SpeechMicroexpressionSystem(random);
  system.setParams({
    attackMs: 100,
    releaseMs: 400,
    gapThresholdMs: 250,
    blinkProbability: 0.6,
    onsetThreshold: 0.3,
    onsetMinVolume: 0.4,
    refractoryMs: 1_500,
    flickDurationMs: 250,
  });
  return system;
}

describe("SpeechMicroexpressionSystem", () => {
  it("無音から発話へ入ると engagement が attack 時間で立ち上がる", () => {
    const system = createSystem();

    const halfway = system.update(0.05, mouth(0.8), true);
    expect(system.engagement).toBeCloseTo(0.5);
    expect(halfway.browWeight).toBeGreaterThan(0);
    expect(halfway.eyeWeight).toBeGreaterThan(0);

    system.update(0.05, mouth(0.8), true);
    expect(system.engagement).toBe(1);
  });

  it("発話から無音へ入ると engagement が release 時間で下がる", () => {
    const system = createSystem();
    system.update(0.1, mouth(0.8), true);

    const halfway = system.update(0.2, SILENCE, true);
    expect(system.engagement).toBeCloseTo(0.5);
    expect(halfway.eyeWeight).toBeGreaterThan(0);

    system.update(0.2, SILENCE, true);
    expect(system.engagement).toBe(0);
  });

  it("発話後の無音ギャップが確定すると確率抽選で blink を要求する", () => {
    const random = vi.fn(() => 0.2);
    const system = createSystem(random);
    system.update(0.1, mouth(0.8), true);

    expect(system.update(0.2, SILENCE, true).blinkRequested).toBe(false);
    expect(system.update(0.06, SILENCE, true).blinkRequested).toBe(true);
    expect(random).toHaveBeenCalledOnce();
  });

  it("同じ無音ギャップでは blink を一度しか抽選しない", () => {
    const random = vi.fn(() => 0.2);
    const system = createSystem(random);
    system.update(0.1, mouth(0.8), true);

    expect(system.update(0.3, SILENCE, true).blinkRequested).toBe(true);
    expect(system.update(0.3, SILENCE, true).blinkRequested).toBe(false);
    expect(random).toHaveBeenCalledOnce();

    system.update(0.1, mouth(0.8), true);
    expect(system.update(0.3, SILENCE, true).blinkRequested).toBe(true);
    expect(random).toHaveBeenCalledTimes(2);
  });

  it("急峻な onset で眉 flick を出し、refractory 中の再発火を抑える", () => {
    const system = createSystem();
    system.setParams({ engagementEnabled: false });

    expect(system.update(0.05, mouth(0.8), true).browWeight).toBeGreaterThan(0);
    system.update(0.25, SILENCE, true);
    expect(system.update(0.05, mouth(0.8), true).browWeight).toBe(0);

    system.update(1.2, SILENCE, true);
    expect(system.update(0.05, mouth(0.8), true).browWeight).toBeGreaterThan(0);
  });

  it("mouth=null は出力と内部状態を即座にリセットする", () => {
    const random = vi.fn(() => 0.2);
    const system = createSystem(random);
    system.update(0.1, mouth(0.8), true);

    expect(system.update(0.05, null, true)).toEqual({
      browWeight: 0,
      eyeWeight: 0,
      blinkRequested: false,
    });
    expect(system.engagement).toBe(0);
    expect(system.update(0.3, SILENCE, true).blinkRequested).toBe(false);
    expect(random).not.toHaveBeenCalled();
  });

  it("enabled=false は出力と内部状態を即座にリセットする", () => {
    const system = createSystem();
    system.update(0.1, mouth(0.8), true);

    expect(system.update(0.05, mouth(0.8), false)).toEqual({
      browWeight: 0,
      eyeWeight: 0,
      blinkRequested: false,
    });
    expect(system.engagement).toBe(0);
  });

  it("engagement と flick の合算を morph ごとの上限でクランプする", () => {
    const system = createSystem();
    system.setParams({
      engagementBrowWeight: 1,
      engagementEyeWeight: 1,
      flickWeight: 1,
      browWeightMax: 0.12,
      eyeWeightMax: 0.08,
    });

    const out = system.update(0.1, mouth(1), true);
    expect(out.browWeight).toBe(0.12);
    expect(out.eyeWeight).toBe(0.08);
  });

  it("update は allocation-free の同一出力 object を再利用する", () => {
    const system = createSystem();
    const first = system.update(0.05, mouth(0.8), true);
    const second = system.update(0.05, mouth(0.8), true);
    expect(second).toBe(first);
  });
});

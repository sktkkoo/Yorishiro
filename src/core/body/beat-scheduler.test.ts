import { describe, expect, it } from "vitest";
import { IdleBeatScheduler } from "./beat-scheduler";
import type { BeatDef, BeatProfile, BeatProfileMap, BeatTarget } from "./beat-types";

function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DT = 1 / 60;

function mockTarget(): BeatTarget & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {};
  const track =
    (name: string) =>
    (...args: unknown[]) => {
      calls[name] ??= [];
      calls[name].push(args);
    };
  return {
    calls,
    glance: track("glance"),
    addSpineEnvelope: track("addSpineEnvelope"),
    addPostureEnvelope: track("addPostureEnvelope"),
    triggerDeepBreath: track("triggerDeepBreath"),
    requestBlink: track("requestBlink"),
    injectMicroExpression: track("injectMicroExpression"),
  };
}

const lightBeat: BeatDef = {
  name: "test-light",
  cooldown: 2,
  weight: "light",
  keyframes: [{ at: 0, pose: { spine: { z: 0.01, durationS: 0.3 } } }],
};
const heavyBeat: BeatDef = {
  name: "test-heavy",
  cooldown: 8,
  weight: "heavy",
  keyframes: [
    { at: 0, pose: { spine: { z: -0.003, durationS: 0.08 } } },
    { at: 0.07, pose: { spine: { z: 0.012, durationS: 0.4 } } },
  ],
  secondaryActions: [{ at: 0.07, fire: (t) => t.requestBlink() }],
};
const testProfile: BeatProfile = {
  beats: [lightBeat, heavyBeat],
  baseInterval: 2,
  scaleWithIntensity: true,
};
const silent: BeatProfile = { beats: [], baseInterval: 30, scaleWithIntensity: false };
const profiles: BeatProfileMap = {
  idle: testProfile,
  thinking: testProfile,
  reading: silent,
  writing: silent,
  running: silent,
};

describe("IdleBeatScheduler", () => {
  const total = (target: ReturnType<typeof mockTarget>) =>
    Object.values(target.calls).reduce((sum, calls) => sum + calls.length, 0);

  it("idle + 高 intensity で beat が発火する", () => {
    const target = mockTarget();
    const scheduler = new IdleBeatScheduler(profiles, seededRandom(1));
    scheduler.setIntensity(2.5);
    scheduler.setState("idle", target);
    for (let t = 0; t < 30; t += DT) scheduler.update(DT, target, false, false);
    expect(total(target)).toBeGreaterThan(0);
  });

  it("writing profile で beat がほぼ発火しない", () => {
    const target = mockTarget();
    const scheduler = new IdleBeatScheduler(profiles, seededRandom(2));
    scheduler.setIntensity(2.5);
    scheduler.setState("writing", target);
    for (let t = 0; t < 15; t += DT) scheduler.update(DT, target, false, false);
    expect(total(target)).toBe(0);
  });

  it("intensity 0 で beat がほぼ発火しない", () => {
    const target = mockTarget();
    const scheduler = new IdleBeatScheduler(profiles, seededRandom(3));
    scheduler.setIntensity(0);
    scheduler.setState("idle", target);
    for (let t = 0; t < 15; t += DT) scheduler.update(DT, target, false, false);
    expect(total(target)).toBe(0);
  });

  it("animationClaimed 中は motion keyframe を drop する", () => {
    const profile: BeatProfile = {
      beats: [lightBeat],
      baseInterval: 0.1,
      scaleWithIntensity: true,
    };
    const target = mockTarget();
    const scheduler = new IdleBeatScheduler({ ...profiles, idle: profile }, seededRandom(7));
    scheduler.setIntensity(3.0);
    scheduler.setState("idle", target);
    for (let t = 0; t < 5; t += DT) scheduler.update(DT, target, true, false);
    expect((target.calls.addSpineEnvelope ?? []).length).toBe(0);
  });

  it("state 遷移で 1-shot beat が発火する", () => {
    const target = mockTarget();
    const scheduler = new IdleBeatScheduler(profiles, seededRandom(8));
    scheduler.setIntensity(1.0);
    scheduler.setState("idle", target);
    scheduler.setState("thinking", target);
    for (let t = 0; t < 1; t += DT) scheduler.update(DT, target, false, false);
    expect(total(target)).toBeGreaterThan(0);
  });

  it("timed keyframe: at>0 の keyframe が遅延後に発火", () => {
    const delayed: BeatDef = {
      name: "d",
      cooldown: 1,
      weight: "light",
      keyframes: [
        { at: 0, pose: { spine: { z: -0.003, durationS: 0.08 } } },
        { at: 0.1, pose: { spine: { z: 0.01, durationS: 0.3 } } },
      ],
    };
    const target = mockTarget();
    const scheduler = new IdleBeatScheduler(
      { ...profiles, idle: { beats: [delayed], baseInterval: 0.1, scaleWithIntensity: true } },
      seededRandom(5),
    );
    scheduler.setIntensity(3.0);
    scheduler.setState("idle", target);
    for (let t = 0; t < 1; t += DT) scheduler.update(DT, target, false, false);
    expect((target.calls.addSpineEnvelope ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import type { Disposable } from "@yorishiro/sdk";
import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBodyStateExpressionAdapter } from "../../runtime/agent-state-expression/body-adapter";
import type { StateExpressionCue } from "../../runtime/agent-state-expression/types";
import type { ClaimKind, ClaimState } from "../../runtime/ui-claim-state";
import { ZERO_MOUTH } from "../voice/mouth-values";
import { AnimationPlayer } from "./animation-player";
import { Body } from "./index";
import { DEFAULT_MOTION_CATALOG } from "./motion-catalog";

type Playback = Awaited<ReturnType<AnimationPlayer["play"]>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function playback() {
  const completion = deferred<void>();
  return {
    id: 1,
    completion: completion.promise,
    setWeight: vi.fn(),
    stop: vi.fn(async () => completion.resolve()),
    cancel: vi.fn(() => completion.resolve()),
  } satisfies Playback;
}

function createBody(modelSha256?: string) {
  const bones = new Map<VRMHumanBoneName, THREE.Object3D>();
  const scene = new THREE.Object3D();
  const claimed = new Set<ClaimKind>();
  const claims: ClaimState = {
    isClaimed: (kind) => claimed.has(kind),
    claim: (kind): Disposable => {
      claimed.add(kind);
      return { dispose: () => claimed.delete(kind) };
    },
    releaseAll: () => claimed.clear(),
  };
  const vrm = {
    meta: { metaVersion: "1" },
    scene,
    humanoid: {
      resetNormalizedPose: () => {},
      getNormalizedBoneNode: (name: VRMHumanBoneName) => {
        if (!bones.has(name)) {
          const bone = new THREE.Object3D();
          bone.name = name;
          bones.set(name, bone);
          scene.add(bone);
        }
        return bones.get(name);
      },
    },
    expressionManager: { getExpression: () => null, setValue: () => {}, update: () => {} },
    lookAt: { yaw: 0, pitch: 0, applier: { applyYawPitch: () => {} } },
    update: () => {},
  } as unknown as VRM;
  const body = new Body(vrm, undefined, claims, { modelSha256 });
  bodies.push(body);
  return { body, claims, vrm };
}

const bodies: Body[] = [];

afterEach(() => {
  for (const body of bodies.splice(0)) body.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function flush() {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

function advance(body: Body, seconds: number) {
  const frames = Math.ceil(seconds * 60);
  for (let frame = 0; frame < frames; frame++) body.update(1 / 60, frame / 60);
}

// Foreground ownership tests isolate the foundation, which has separate
// real-mixer coverage below and its own cancellation/gain tests.
function mockPerformanceLibrary() {
  vi.spyOn(AnimationPlayer.prototype, "evaluateTransition").mockReturnValue({
    cost: 0,
    startTimeSec: 0,
  });
  return vi
    .spyOn(AnimationPlayer.prototype, "preload")
    .mockImplementation(async (_ref, options) => options?.mask !== "lower-body");
}

function mockSurveyOnlyLibrary() {
  mockPerformanceLibrary();
  return vi
    .mocked(AnimationPlayer.prototype.evaluateTransition)
    .mockImplementation((ref) =>
      ref === "/animations/recorded-idle/survey.vrma" ? { cost: 0, startTimeSec: 0 } : null,
    );
}

function mockStandingBase() {
  const sha = "a".repeat(64);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        schemaVersion: 1,
        targetModelSha256: sha,
        units: [
          {
            id: "standing",
            animation: "/animations/recorded-body/standing.vrma",
            context: "idle",
            startTimeSec: 2,
            endTimeSec: 8,
            contactWindows: [{ startTimeSec: 1, endTimeSec: 10, feet: "both" }],
          },
        ],
      }),
    })),
  );
  vi.spyOn(AnimationPlayer.prototype, "preloadRecordedBase").mockResolvedValue(true);
  const base = {
    ...playback(),
    phaseSec: 2,
    held: false,
    paused: false,
    setPaused: vi.fn(),
    setUpperWeight: vi.fn(),
    setAxialStrength: vi.fn(),
  };
  const playBase = vi.spyOn(AnimationPlayer.prototype, "playRecordedBase").mockResolvedValue(base);
  return { sha, base, playBase };
}

const speechRequest = {
  source: "system",
  priority: "speech-expression",
  intent: "agree",
  context: "speech",
} as const;

function cue(overrides: Partial<StateExpressionCue> = {}): StateExpressionCue {
  return {
    utteranceId: "u1",
    atMs: 0,
    state: "acknowledging",
    expression: "happy",
    expressionWeight: 0.42,
    gestureIntent: "agree",
    intensity: "small",
    ...overrides,
  };
}

describe("recorded motion Body integration", () => {
  it("keeps supporting legs through terminal activity and upper-body persona reactions, then yields to a claim", async () => {
    const { sha, base } = mockStandingBase();
    const { body, claims } = createBody(sha);
    body.setMotionIntensity(0.95);
    await body.initializeRecordedBody();
    expect(body.getRecordedBodySnapshot().active?.id).toBe("standing");
    expect(base.setUpperWeight).toHaveBeenLastCalledWith(0.95, 0);
    for (const intensity of [0.5, 0, 0.95]) {
      body.setMotionIntensity(intensity);
      advance(body, 0.4);
      expect(body.getRecordedBodySnapshot().active?.id).toBe("standing");
      expect(base.stop).not.toHaveBeenCalled();
      expect(base.cancel).not.toHaveBeenCalled();
      expect(base.setPaused).toHaveBeenLastCalledWith(intensity === 0);
    }
    vi.spyOn(AnimationPlayer.prototype, "play").mockResolvedValue(playback());
    body.createCharacterAPI().play("anim:VRMA_small_nod", { mask: "upper-body" });
    await flush();
    for (const state of ["reading", "writing", "running", "thinking", "idle"] as const) {
      body.setState(state);
      advance(body, 0.1);
      expect(body.getRecordedBodySnapshot().active?.id).toBe("standing");
      expect(base.stop).not.toHaveBeenCalled();
      expect(base.cancel).not.toHaveBeenCalled();
    }
    claims.claim("animation");
    body.update(1 / 60, 1);
    expect(base.cancel).toHaveBeenCalledOnce();
    expect(body.getRecordedBodySnapshot().active).toBeNull();
  });

  it.each([
    "user-speaking",
    "animation-claim",
  ] as const)("keeps a rare finite survey separate from the body base, then yields to %s", async (interruption) => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    mockSurveyOnlyLibrary();
    const { sha, base, playBase } = mockStandingBase();
    const survey = playback();
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockResolvedValue(survey);
    const { body, claims } = createBody(sha);
    body.setMotionIntensity(0.95);
    await body.initializeRecordedBody();
    await body.prepareMotionLibrary();

    advance(body, 149);
    expect(play).not.toHaveBeenCalled();
    advance(body, 2);
    await flush();
    expect(play).toHaveBeenCalledOnce();
    expect(play.mock.calls[0][0]).toBe("/animations/recorded-idle/survey.vrma");
    expect(play.mock.calls[0][1]).toMatchObject({
      loop: false,
      mask: "upper-body",
      transition: "immediate",
      speed: 1,
      weight: 0.95,
      fadeInMs: 800,
      fadeOutMs: 800,
    });
    expect(play.mock.calls[0][1]?.maxDurationMs).toBeUndefined();
    advance(body, 1);
    await flush();
    expect(body.getMotionSnapshot().active?.animation).toBe(
      "/animations/recorded-idle/survey.vrma",
    );
    expect(play).toHaveBeenCalledOnce();
    expect(survey.stop).not.toHaveBeenCalled();
    expect(survey.cancel).not.toHaveBeenCalled();
    expect(playBase).toHaveBeenCalledOnce();
    expect(base.stop).not.toHaveBeenCalled();
    expect(base.cancel).not.toHaveBeenCalled();

    if (interruption === "user-speaking") body.setMotionConversationPhase(interruption);
    else claims.claim("animation");
    body.update(1 / 60, 303);
    await flush();
    expect(body.getMotionSnapshot().active).toBeNull();
    if (interruption === "user-speaking") {
      expect(survey.stop).toHaveBeenCalledExactlyOnceWith(800);
      expect(survey.cancel).not.toHaveBeenCalled();
      expect(base.stop).not.toHaveBeenCalled();
      expect(base.cancel).not.toHaveBeenCalled();
      expect(body.getRecordedBodySnapshot().active?.id).toBe("standing");
    } else {
      expect(survey.cancel).toHaveBeenCalledOnce();
      expect(survey.stop).not.toHaveBeenCalled();
      expect(base.cancel).toHaveBeenCalledOnce();
    }
  });

  it("backs off an incompatible rare survey entry and retries it without another full wait", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    mockPerformanceLibrary();
    const evaluate = vi.mocked(AnimationPlayer.prototype.evaluateTransition).mockReturnValue(null);
    const { sha, base } = mockStandingBase();
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockResolvedValue(playback());
    const { body } = createBody(sha);
    body.setMotionIntensity(0.95);
    await body.initializeRecordedBody();
    await body.prepareMotionLibrary();

    advance(body, 91);
    expect(play).not.toHaveBeenCalled();
    const surveyEvaluations = () =>
      evaluate.mock.calls.filter(([ref]) => ref === "/animations/recorded-idle/survey.vrma");
    expect(surveyEvaluations()).toHaveLength(1);
    expect(surveyEvaluations()[0][1]).toEqual({
      loop: false,
      mask: "upper-body",
      transition: "immediate",
      speed: 1,
      weight: 0.95,
      fadeInMs: 800,
      fadeOutMs: 800,
    });
    advance(body, 1.3);
    expect(surveyEvaluations()).toHaveLength(1);
    evaluate.mockImplementation((ref) =>
      ref === "/animations/recorded-idle/survey.vrma" ? { cost: 0, startTimeSec: 0 } : null,
    );
    advance(body, 0.3);
    await flush();
    expect(surveyEvaluations()).toHaveLength(2);
    expect(play).toHaveBeenCalledOnce();
    expect(body.getMotionSnapshot().active?.animation).toBe(
      "/animations/recorded-idle/survey.vrma",
    );
    expect(base.stop).not.toHaveBeenCalled();
    expect(base.cancel).not.toHaveBeenCalled();
  });

  it.each([
    "mouth",
    "expression",
  ] as const)("does not count ungrounded %s ownership toward the rare idle wait", async (owner) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    mockSurveyOnlyLibrary();
    const { sha } = mockStandingBase();
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockResolvedValue(playback());
    const { body } = createBody(sha);
    body.setMotionIntensity(0.95);
    await body.initializeRecordedBody();
    await body.prepareMotionLibrary();
    let release: () => void;
    if (owner === "mouth") {
      body.setLipSyncSource({
        isMouthActive: () => true,
        sampleMouth: () => ({ ...ZERO_MOUTH }),
      });
      release = () => body.setLipSyncSource(null);
    } else {
      const expression = body.acquireSpeechStateExpression({ preset: "neutral" });
      release = () => expression.release();
    }
    advance(body, 91);
    expect(play).not.toHaveBeenCalled();
    release();
    advance(body, 89);
    expect(play).not.toHaveBeenCalled();
    advance(body, 2);
    await flush();
    expect(play).toHaveBeenCalledOnce();
    expect(play.mock.calls[0][0]).toBe("/animations/recorded-idle/survey.vrma");
  });

  it("varies safe upper-body recordings briefly with quiet gaps while the recorded legs continue", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    mockPerformanceLibrary();
    const { sha, base, playBase } = mockStandingBase();
    const first = playback();
    const second = playback();
    const play = vi
      .spyOn(AnimationPlayer.prototype, "play")
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const { body } = createBody(sha);
    await body.initializeRecordedBody();
    await body.prepareMotionLibrary();

    advance(body, 14);
    expect(play).not.toHaveBeenCalled();
    advance(body, 1.1);
    await flush();
    expect(play).toHaveBeenCalledOnce();
    expect(play.mock.calls[0][0]).toBe("anim:VRMA_06_HandOnHip");
    expect(play.mock.calls[0][1]).toMatchObject({ loop: true, mask: "upper-body" });
    advance(body, 7.8);
    expect(first.stop).not.toHaveBeenCalled();
    advance(body, 0.3);
    await flush();
    expect(first.stop).toHaveBeenCalledExactlyOnceWith(800);
    expect(body.getMotionSnapshot().active).toBeNull();

    advance(body, 14);
    expect(play).toHaveBeenCalledOnce();
    advance(body, 1.2);
    await flush();
    expect(play).toHaveBeenCalledTimes(2);
    expect(play.mock.calls[1][0]).toBe("anim:Idle");
    expect(play.mock.calls[1][1]).toMatchObject({ loop: true, mask: "upper-body" });
    advance(body, 8.1);
    await flush();
    expect(second.stop).toHaveBeenCalledExactlyOnceWith(800);
    expect(body.getMotionSnapshot().active).toBeNull();
    expect(playBase).toHaveBeenCalledOnce();
    expect(base.stop).not.toHaveBeenCalled();
    expect(base.cancel).not.toHaveBeenCalled();
    expect(body.getRecordedBodySnapshot().active?.id).toBe("standing");
  });

  it.each([
    "assistant-speaking",
    "manual",
  ] as const)("varies posture across listening and thinking, replacing only its ambient loop before %s", async (nextOwner) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    mockPerformanceLibrary();
    const { sha, base } = mockStandingBase();
    const played: Playback[] = [];
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockImplementation(async () => {
      const active = playback();
      played.push(active);
      return active;
    });
    const { body } = createBody(sha);
    body.setMotionConversationPhase("user-speaking");
    await body.initializeRecordedBody();
    await body.prepareMotionLibrary();
    advance(body, 1);
    await flush();
    expect(play.mock.calls[0][0]).toBe("anim:Idle");
    expect(body.getRecordedBodySnapshot()).toMatchObject({
      conversationPhase: "user-speaking",
      postureVariation: { eligible: true, activeAnimation: null },
      occasionalIdle: { eligible: false, activeAnimation: null },
    });

    advance(body, 14.2);
    await flush();
    expect(play).toHaveBeenCalledTimes(2);
    expect(play.mock.calls[1][0]).toBe("anim:VRMA_06_HandOnHip");
    body.setMotionConversationPhase("assistant-responding");
    body.setState("thinking");
    advance(body, 1);
    await flush();
    expect(play).toHaveBeenCalledTimes(2);
    expect(body.getRecordedBodySnapshot()).toMatchObject({
      conversationPhase: "assistant-responding",
      postureVariation: { eligible: true, activeAnimation: "anim:VRMA_06_HandOnHip" },
    });
    expect(played[1].stop).not.toHaveBeenCalled();

    if (nextOwner === "assistant-speaking") {
      body.setMotionConversationPhase(nextOwner);
      body.update(0, 17);
      await flush();
      expect(played[1].stop).toHaveBeenCalledExactlyOnceWith(800);
    } else {
      const manual = body.acquireMotionSlot({
        source: "mcp",
        priority: "mcp-conscious",
        animation: "anim:explicit",
        options: { mask: "upper-body" },
      });
      await flush();
      advance(body, 1);
      await flush();
      expect(manual.isActive()).toBe(true);
      expect(body.getMotionSnapshot().active?.animation).toBe("anim:explicit");
    }
    expect(body.getRecordedBodySnapshot().postureVariation).toMatchObject({
      eligible: false,
      activeAnimation: null,
    });
    expect(base.stop).not.toHaveBeenCalled();
    expect(base.cancel).not.toHaveBeenCalled();
  });

  it("forwards quiet Normal and Over axial gains without relinquishing or restarting the body base", async () => {
    const { sha, base, playBase } = mockStandingBase();
    const { body } = createBody(sha);
    await body.initializeRecordedBody();
    expect(base.setAxialStrength).toHaveBeenLastCalledWith({ torso: 0.18, head: 0.06 }, 0);
    body.setMotionIntensity(3);
    body.update(0, 0);
    expect(base.setAxialStrength.mock.lastCall?.[0]).toEqual({ torso: 0.18, head: 0.06 });
    advance(body, 0.1);
    expect(base.setAxialStrength.mock.lastCall?.[0].torso).toBeGreaterThan(0.18);
    expect(base.setAxialStrength.mock.lastCall?.[0].torso).toBeLessThan(0.65);
    advance(body, 1.9);
    expect(base.setAxialStrength.mock.lastCall?.[0]).toEqual({
      torso: expect.closeTo(0.65, 5),
      head: expect.closeTo(0.45, 5),
    });
    body.setMotionIntensity(0);
    advance(body, 2);
    expect(base.setAxialStrength.mock.lastCall?.[0]).toEqual({
      torso: expect.closeTo(0, 5),
      head: expect.closeTo(0, 5),
    });
    expect(base.setPaused).toHaveBeenLastCalledWith(true);
    body.setMotionIntensity(0.95);
    advance(body, 2);
    expect(base.setPaused).toHaveBeenLastCalledWith(false);
    expect(base.setAxialStrength.mock.lastCall?.[0]).toEqual({
      torso: expect.closeTo(0.171, 5),
      head: expect.closeTo(0.057, 5),
    });
    expect(playBase).toHaveBeenCalledOnce();
    expect(base.stop).not.toHaveBeenCalled();
    expect(base.cancel).not.toHaveBeenCalled();
  });

  it.each([
    3, 25,
  ])("resumes explanation as a real %ss finite gesture finishes, without adding idle settling", async (duration) => {
    mockPerformanceLibrary();
    const { body, vrm } = createBody();
    const arm = vrm.humanoid.getNormalizedBoneNode("leftLowerArm");
    if (!arm) throw new Error("test arm is required");
    const player = (body as unknown as { animationPlayer: AnimationPlayer }).animationPlayer;
    const cache = (player as unknown as { clipCache: Map<string, THREE.AnimationClip> }).clipCache;
    for (const entry of DEFAULT_MOTION_CATALOG) {
      cache.set(
        entry.animation,
        new THREE.AnimationClip(entry.animation, duration, [
          new THREE.QuaternionKeyframeTrack(
            `${arm.name}.quaternion`,
            [0, duration / 2, duration],
            [0, 0, 0, 1, Math.sin(0.2), 0, 0, Math.cos(0.2), 0, 0, 0, 1],
          ),
        ]),
      );
    }
    await body.prepareMotionLibrary();
    body.setMotionConversationPhase("assistant-speaking");
    const handle = body.acquireSemanticMotion(speechRequest);
    expect(handle).not.toBeNull();
    const gesture = body.getMotionDirectorSnapshot().lastDecision;
    expect(gesture?.options).toMatchObject({ loop: false, maxDurationMs: 6_000, fadeOutMs: 600 });
    await flush();
    let elapsed = 0;
    while (handle?.isActive() && elapsed < 7) {
      advance(body, 1 / 60);
      elapsed += 1 / 60;
      await flush();
    }
    await expect(handle?.completion).resolves.toEqual({ reason: "completed" });
    if (duration === 3) expect(elapsed).toBeCloseTo(duration / (gesture?.options.speed ?? 1), 1);
    else expect(elapsed).toBeGreaterThanOrEqual(6);
    expect(elapsed).toBeLessThanOrEqual(6.6);
    // Ownership completes when the authored exit starts fading. The next
    // frame may select a compatible background without cutting that exit.
    expect(body.getMotionSnapshot().active).toBeNull();
    expect(player.getTotalEffectiveWeight()).toBeGreaterThan(0);
    advance(body, 1 / 60);
    await flush();
    expect(body.getMotionSnapshot().active?.priority).toBe("idle-fidget");
    expect(body.getMotionDirectorSnapshot().lastDecision).toMatchObject({
      context: "speech",
      intent: "explain",
      options: { loop: true, transition: "matched", fadeInMs: 1_200 },
    });
  });

  it("still rejects incompatible or cold backgrounds after a completed speech gesture", async () => {
    mockPerformanceLibrary();
    const completed = deferred<void>();
    const play = vi
      .spyOn(AnimationPlayer.prototype, "play")
      .mockResolvedValueOnce({ ...playback(), completion: completed.promise })
      .mockImplementation(async () => playback());
    const { body } = createBody();
    await body.prepareMotionLibrary();
    body.setMotionConversationPhase("assistant-speaking");
    const handle = body.acquireSemanticMotion(speechRequest);
    await flush();
    advance(body, 3);
    const evaluate = vi.mocked(AnimationPlayer.prototype.evaluateTransition).mockReturnValue(null);
    completed.resolve();
    await handle?.completion;
    advance(body, 1 / 60);
    expect(play).toHaveBeenCalledOnce();
    expect(body.getMotionSnapshot().active).toBeNull();
    expect(body.getMotionDirectorSnapshot().suppressedReason).toBe("transition");
    const calls = evaluate.mock.calls.length;
    advance(body, 2.4);
    expect(evaluate).toHaveBeenCalledTimes(calls);
    evaluate.mockReturnValue({ cost: 0, startTimeSec: 1.2 });
    advance(body, 0.2);
    expect(play).toHaveBeenCalledTimes(2);
    expect(body.getMotionDirectorSnapshot().lastDecision?.intent).toBe("explain");
  });

  it.each([
    "idle",
    "user-speaking",
  ] as const)("retains idle settling when a speech gesture ends after the phase becomes %s", async (phase) => {
    mockPerformanceLibrary();
    const completed = deferred<void>();
    const play = vi
      .spyOn(AnimationPlayer.prototype, "play")
      .mockResolvedValueOnce({ ...playback(), completion: completed.promise })
      .mockImplementation(async () => playback());
    const { body } = createBody();
    await body.prepareMotionLibrary();
    body.setMotionConversationPhase("assistant-speaking");
    const handle = body.acquireSemanticMotion(speechRequest);
    await flush();
    advance(body, 3);
    body.setMotionConversationPhase(phase);
    completed.resolve();
    await handle?.completion;
    advance(body, 0.1);
    expect(play).toHaveBeenCalledOnce();
    advance(body, 2.5);
    expect(play).toHaveBeenCalledTimes(2);
    expect(body.getMotionDirectorSnapshot().lastDecision?.context).toBe("idle");
  });

  it("does not accelerate ambient recovery after a manual owner preempts the speech gesture", async () => {
    mockPerformanceLibrary();
    const completed = deferred<void>();
    const play = vi
      .spyOn(AnimationPlayer.prototype, "play")
      .mockResolvedValueOnce({ ...playback(), completion: completed.promise })
      .mockImplementation(async () => playback());
    const { body } = createBody();
    await body.prepareMotionLibrary();
    body.setMotionConversationPhase("assistant-speaking");
    body.acquireSemanticMotion(speechRequest);
    await flush();
    advance(body, 3);
    const owner = body.acquireMotionSlot({
      source: "persona",
      priority: "persona-handler",
      animation: "anim:manual",
      options: { loop: true },
    });
    completed.resolve();
    await flush();
    advance(body, 1);
    expect(owner.isActive()).toBe(true);
    expect(play).toHaveBeenCalledTimes(2);
    owner.release();
    advance(body, 0.1);
    expect(play).toHaveBeenCalledTimes(2);
    advance(body, 2.5);
    expect(play).toHaveBeenCalledTimes(3);
  });

  it.each([
    "user-speaking",
    "idle",
    "disconnected",
  ] as const)("retires the speech baseline on %s even when every next seam is rejected", async (phase) => {
    mockPerformanceLibrary();
    const active = playback();
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockResolvedValue(active);
    const { body } = createBody();
    await body.prepareMotionLibrary();
    body.setMotionConversationPhase("assistant-speaking");
    advance(body, 1.3);
    await flush();
    expect(play).toHaveBeenCalledOnce();
    expect(play.mock.calls[0][1]?.loop).toBe(true);
    vi.mocked(AnimationPlayer.prototype.evaluateTransition).mockReturnValue(null);
    body.setMotionConversationPhase(phase);
    await flush();
    expect(active.stop).toHaveBeenCalledWith(650);
    advance(body, 10);
    await flush();
    expect(play).toHaveBeenCalledOnce();
  });

  it.each([
    "reading",
    "writing",
    "running",
  ] as const)("sustains audible neutral speech during concurrent %s activity", async (state) => {
    mockPerformanceLibrary();
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockResolvedValue(playback());
    const { body, claims } = createBody();
    await body.prepareMotionLibrary();
    body.setState(state);
    body.setMotionConversationPhase("assistant-speaking");
    advance(body, 1.3);
    await flush();
    expect(play).toHaveBeenCalledOnce();
    expect(body.getMotionDirectorSnapshot().lastDecision).toMatchObject({
      intent: "explain",
      context: "speech",
    });
    claims.claim("animation");
    advance(body, 20);
    await flush();
    expect(play).toHaveBeenCalledOnce();
  });

  it("scores the actual reduced-motion gain and passes the selected phase into playback", async () => {
    mockPerformanceLibrary();
    const evaluate = vi.mocked(AnimationPlayer.prototype.evaluateTransition);
    evaluate.mockReturnValue({ cost: 0.02, startTimeSec: 1.7 });
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockResolvedValue(playback());
    const { body } = createBody();
    await body.prepareMotionLibrary();
    body.setMotionIntensity(0.3);
    advance(body, 1.3);
    await flush();
    expect(play).toHaveBeenCalledOnce();
    const [ref, options] = play.mock.calls[0];
    expect(options?.startTimeSec).toBe(1.7);
    expect(evaluate).toHaveBeenCalledWith(
      ref,
      expect.objectContaining({ weight: options?.weight }),
    );
  });

  it("retains recorded legs under upper-body speech and yields the whole body to explicit owners", async () => {
    vi.spyOn(AnimationPlayer.prototype, "preload").mockImplementation(
      async (ref) => ref === "anim:Idle",
    );
    const { body, vrm, claims } = createBody();
    const leg = vrm.humanoid.getNormalizedBoneNode("leftUpperLeg");
    const arm = vrm.humanoid.getNormalizedBoneNode("leftLowerArm");
    const hips = vrm.humanoid.getNormalizedBoneNode("hips");
    if (!leg || !arm || !hips) throw new Error("test bones are required");
    hips.position.y = 0.9;
    const lowerBones = ["hips"];
    for (const side of ["left", "right"] as const) {
      let parent = hips;
      for (const [suffix, y, z] of [
        ["UpperLeg", -0.04, 0],
        ["LowerLeg", -0.4, 0],
        ["Foot", -0.4, 0],
        ["Toes", -0.03, 0.1],
      ] as const) {
        const name = `${side}${suffix}` as VRMHumanBoneName;
        const bone = vrm.humanoid.getNormalizedBoneNode(name);
        if (!bone) throw new Error(`Missing ${name}`);
        parent.add(bone);
        bone.position.set(suffix === "UpperLeg" ? (side === "left" ? 0.08 : -0.08) : 0, y, z);
        parent = bone;
        lowerBones.push(name);
      }
    }
    Object.assign(vrm.humanoid, {
      normalizedHumanBonesRoot: vrm.scene,
      normalizedRestPose: Object.fromEntries(
        lowerBones.map((name) => {
          const bone = vrm.humanoid.getNormalizedBoneNode(name as VRMHumanBoneName);
          return [
            name,
            { position: bone?.position.toArray(), rotation: bone?.quaternion.toArray() },
          ];
        }),
      ),
    });
    const player = (body as unknown as { animationPlayer: AnimationPlayer }).animationPlayer;
    const cache = (player as unknown as { clipCache: Map<string, THREE.AnimationClip> }).clipCache;
    const rotationTrack = (bone: THREE.Object3D, angle: number) =>
      new THREE.QuaternionKeyframeTrack(
        `${bone.name}.quaternion`,
        [0, 4, 8],
        [0, 0, 0, 1, Math.sin(angle / 2), 0, 0, Math.cos(angle / 2), 0, 0, 0, 1],
      );
    cache.set(
      "anim:Idle",
      new THREE.AnimationClip("idle", 8, [rotationTrack(hips, 0), rotationTrack(leg, 0.008)]),
    );
    cache.set("anim:upper", new THREE.AnimationClip("upper", 8, [rotationTrack(arm, 0.6)]));
    cache.set("anim:whole", new THREE.AnimationClip("whole", 8, [rotationTrack(leg, 0.3)]));
    await body.prepareMotionLibrary();
    advance(body, 0.1);
    await flush();
    advance(body, 1.3);
    await flush();
    expect(player.getFoundationEffectiveWeight()).toBeCloseTo(1);
    const beforeSpeech = leg.rotation.x;
    body.acquireMotionSlot({
      source: "system",
      priority: "speech-expression",
      animation: "anim:upper",
      options: { mask: "upper-body", loop: true, weight: 1, fadeInMs: 200 },
    });
    await flush();
    advance(body, 1);
    expect(player.getFoundationEffectiveWeight()).toBeCloseTo(1);
    expect(leg.rotation.x).toBeGreaterThan(beforeSpeech);
    expect(arm.rotation.x).toBeGreaterThan(0.05);
    body.acquireMotionSlot({
      source: "persona",
      priority: "persona-handler",
      animation: "anim:whole",
      options: { loop: true, weight: 1, fadeInMs: 200 },
    });
    await flush();
    advance(body, 1);
    expect(player.getFoundationEffectiveWeight()).toBe(0);
    const claim = claims.claim("animation");
    advance(body, 1);
    expect(player.getFoundationEffectiveWeight()).toBe(0);
    claim.dispose();
  });

  it("records neutral speech throughout a long utterance and returns to attentive idle when listening", async () => {
    mockPerformanceLibrary();
    const play = vi
      .spyOn(AnimationPlayer.prototype, "play")
      .mockImplementation(async () => playback());
    const { body } = createBody();
    await body.prepareMotionLibrary();
    const expression = body.acquireSpeechStateExpression({ preset: "neutral" });
    body.setLipSyncSource({
      // Realtime clients keep the analyser active throughout the connection.
      isMouthActive: () => true,
      sampleMouth: () => ({ ...ZERO_MOUTH }),
    });
    body.setMotionConversationPhase("assistant-speaking");
    for (let i = 0; i < 45; i++) {
      advance(body, 1);
      await flush();
    }
    expect(play.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const [ref, options] of play.mock.calls) {
      expect(["anim:Idle Chatting", "anim:Idle Chatting 2"]).toContain(ref);
      expect(options).toMatchObject({ loop: true, transition: "matched", mask: "upper-body" });
    }
    expression.release();
    body.setMotionConversationPhase("user-speaking");
    advance(body, 0.7);
    await flush();
    expect(body.getMotionDirectorSnapshot().lastDecision?.intent).toBe("attentive");
    body.setMotionConversationPhase("idle");
    advance(body, 0.7);
    await flush();
    expect(body.getMotionDirectorSnapshot().lastDecision?.context).toBe("idle");
    expect(body.getMotionDirectorSnapshot().phase).not.toBe("blocked");
  });

  it("fades an active semantic gesture to a new nonzero motion intensity", async () => {
    mockPerformanceLibrary();
    const active = playback();
    vi.spyOn(AnimationPlayer.prototype, "play").mockResolvedValue(active);
    const { body } = createBody();
    await body.prepareMotionLibrary();
    body.acquireSemanticMotion(speechRequest);
    await flush();
    const baseWeight = body.getMotionDirectorSnapshot().lastDecision?.options.weight ?? 0;
    expect(baseWeight).toBeGreaterThan(0);
    body.setMotionIntensity(0.2);
    expect(active.setWeight).toHaveBeenCalledExactlyOnceWith(baseWeight * 0.2, 350);
  });

  it("preserves the real mixer's fade ramp through Body activation at unchanged motion gain", async () => {
    const { body, vrm } = createBody();
    body.setMotionLibraryEnabled(false);
    const arm = vrm.humanoid.getNormalizedBoneNode("leftLowerArm");
    if (!arm) throw new Error("test arm is required");
    arm.quaternion.identity();
    const player = (body as unknown as { animationPlayer: AnimationPlayer }).animationPlayer;
    const cache = (player as unknown as { clipCache: Map<string, THREE.AnimationClip> }).clipCache;
    cache.set(
      "anim:fade-regression",
      new THREE.AnimationClip("fade-regression", 2, [
        new THREE.QuaternionKeyframeTrack(
          `${arm.name}.quaternion`,
          [0, 2],
          [Math.sin(0.5), 0, 0, Math.cos(0.5), Math.sin(0.5), 0, 0, Math.cos(0.5)],
        ),
      ]),
    );
    body.acquireMotionSlot({
      source: "idle",
      priority: "idle-fidget",
      animation: "anim:fade-regression",
      options: { loop: true, fadeInMs: 1_000, weight: 0.9 },
    });
    await flush();
    body.update(0.1, 0.1);
    expect(player.getTotalEffectiveWeight()).toBeGreaterThan(0);
    expect(player.getTotalEffectiveWeight()).toBeLessThan(0.03);
    expect(arm.rotation.x).toBeGreaterThan(0);
    expect(arm.rotation.x).toBeLessThan(0.03);
    body.update(0.4, 0.5);
    expect(player.getTotalEffectiveWeight()).toBeCloseTo(0.45, 5);
    expect(arm.rotation.x).toBeCloseTo(0.45, 5);
    body.update(0.5, 1);
    expect(player.getTotalEffectiveWeight()).toBeCloseTo(0.9, 5);
    expect(arm.rotation.x).toBeCloseTo(0.9, 5);
  });

  it("prepares the local catalog once, tolerates absent assets, and plays only prepared candidates", async () => {
    vi.spyOn(AnimationPlayer.prototype, "evaluateTransition").mockReturnValue({
      cost: 0,
      startTimeSec: 0,
    });
    const preload = vi
      .spyOn(AnimationPlayer.prototype, "preload")
      .mockImplementation(async (animation) => animation !== "anim:Idle");
    const active = playback();
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockResolvedValue(active);
    const { body } = createBody();
    const first = body.prepareMotionLibrary();
    expect(body.prepareMotionLibrary()).toBe(first);
    await first;
    expect(preload).toHaveBeenCalledTimes(
      DEFAULT_MOTION_CATALOG.length +
        DEFAULT_MOTION_CATALOG.filter((entry) => entry.intents.includes("explain")).length +
        1,
    );
    expect(preload).toHaveBeenCalledWith("anim:Idle", { mask: "upper-body", loop: true });
    expect(preload).toHaveBeenCalledWith("/animations/recorded-idle/survey.vrma", {
      mask: "upper-body",
      loop: false,
    });
    advance(body, 1.3);
    await flush();
    expect(play).toHaveBeenCalledOnce();
    expect(play.mock.calls[0][0]).not.toBe("anim:Idle");
    expect(play.mock.calls[0][1]).toMatchObject({
      loop: true,
      mask: "upper-body",
      transition: "matched",
    });
    expect(play.mock.calls[0][1]?.weight).toBeGreaterThanOrEqual(0.85);
    // Resetting the weight here would erase the player's in-progress fade ramp.
    expect(active.setWeight).not.toHaveBeenCalled();
    advance(body, 10);
    expect(play).toHaveBeenCalledOnce();
  });

  it("does not issue ambient motion while assets are loading or continue preload after disposal", async () => {
    const pending = deferred<boolean>();
    const preload = vi.spyOn(AnimationPlayer.prototype, "preload").mockReturnValue(pending.promise);
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockResolvedValue(playback());
    const { body } = createBody();
    const loading = body.prepareMotionLibrary();
    advance(body, 5);
    expect(play).not.toHaveBeenCalled();
    body.dispose();
    pending.resolve(true);
    await loading;
    expect(preload).toHaveBeenCalledOnce();
    advance(body, 5);
    expect(play).not.toHaveBeenCalled();
  });

  it("does not start the survey preload after disposal during the last catalog load", async () => {
    const pending = deferred<boolean>();
    const last = DEFAULT_MOTION_CATALOG[DEFAULT_MOTION_CATALOG.length - 1];
    const preload = vi
      .spyOn(AnimationPlayer.prototype, "preload")
      .mockImplementation((animation, options) =>
        animation === last.animation && options?.loop === false
          ? pending.promise
          : Promise.resolve(options?.mask !== "lower-body"),
      );
    const { body } = createBody();
    const loading = body.prepareMotionLibrary();
    for (let i = 0; i < DEFAULT_MOTION_CATALOG.length; i++) await flush();
    expect(preload).toHaveBeenLastCalledWith(last.animation, { mask: "upper-body", loop: false });
    const calls = preload.mock.calls.length;
    body.dispose();
    pending.resolve(true);
    await loading;
    expect(preload).toHaveBeenCalledTimes(calls);
    expect(
      preload.mock.calls.some(([ref]) => ref === "/animations/recorded-idle/survey.vrma"),
    ).toBe(false);
  });

  it("retains a safe quiet recording through listening and thinking without unsafe substitutions", async () => {
    mockPerformanceLibrary();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const play = vi
      .spyOn(AnimationPlayer.prototype, "play")
      .mockImplementation(async () => playback());
    const { body } = createBody();
    await body.prepareMotionLibrary();
    advance(body, 1.3);
    await flush();
    expect(play).toHaveBeenCalledOnce();
    expect(play.mock.calls[0][0]).toBe("anim:Idle");
    body.setMotionConversationPhase("user-speaking");
    advance(body, 0.7);
    await flush();
    expect(play).toHaveBeenCalledOnce();
    expect(body.getMotionSnapshot().active?.animation).toBe("anim:Idle");
    body.setMotionConversationPhase("user-speaking");
    advance(body, 0.7);
    expect(play).toHaveBeenCalledOnce();
    body.setMotionConversationPhase("assistant-responding");
    advance(body, 0.7);
    expect(play).toHaveBeenCalledOnce();
    expect(body.getMotionSnapshot().active?.animation).toBe("anim:Idle");
    expect(body.getMotionDirectorSnapshot().suppressedReason).toBe("cooldown");
  });

  it("lets speaking own motion, releases it on interruption, and preserves explicit persona priority", async () => {
    mockPerformanceLibrary();
    const speechPlayback = playback();
    const personaPlayback = playback();
    const play = vi
      .spyOn(AnimationPlayer.prototype, "play")
      .mockResolvedValueOnce(playback())
      .mockResolvedValueOnce(speechPlayback)
      .mockResolvedValueOnce(personaPlayback);
    const { body } = createBody();
    await body.prepareMotionLibrary();
    body.setMotionConversationPhase("assistant-speaking");
    advance(body, 0.7);
    await flush();
    expect(play).toHaveBeenCalledOnce();
    expect(body.getMotionDirectorSnapshot().lastDecision?.intent).toBe("explain");
    expect(play.mock.calls[0][1]).toMatchObject({ loop: true, mask: "upper-body" });
    const speech = body.acquireSemanticMotion(speechRequest);
    await flush();
    body.setMotionConversationPhase("interrupted");
    expect(speechPlayback.stop).toHaveBeenCalledWith(250);
    expect(speech?.isActive()).toBe(false);
    const persona = body.acquireMotionSlot({
      source: "persona",
      priority: "persona-handler",
      animation: "anim:persona-owned",
    });
    await flush();
    body.setMotionConversationPhase("user-speaking");
    advance(body, 10);
    expect(personaPlayback.stop).not.toHaveBeenCalled();
    expect(persona.isActive()).toBe(true);
    expect(play).toHaveBeenCalledTimes(3);
  });

  it("yields immediately to an animation claim and protects semantic selection history", async () => {
    mockPerformanceLibrary();
    const active = playback();
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockResolvedValue(active);
    const { body, claims } = createBody();
    await body.prepareMotionLibrary();
    advance(body, 1.3);
    await flush();
    const history = body.getMotionDirectorSnapshot().history;
    const claim = claims.claim("animation");
    advance(body, 1 / 60);
    expect(active.cancel).toHaveBeenCalledOnce();
    expect(body.acquireSemanticMotion(speechRequest)).toBeNull();
    expect(body.getMotionDirectorSnapshot().history).toEqual(history);
    advance(body, 30);
    expect(play).toHaveBeenCalledOnce();
    claim.dispose();
    advance(body, 2);
    expect(play).toHaveBeenCalledOnce();
  });

  it("does not consume semantic candidates while an explicit persona owns higher priority", async () => {
    mockPerformanceLibrary();
    const active = playback();
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockResolvedValue(active);
    const { body } = createBody();
    await body.prepareMotionLibrary();
    const persona = body.acquireMotionSlot({
      source: "persona",
      priority: "persona-handler",
      animation: "anim:persona-owned",
    });
    await flush();
    expect(body.acquireSemanticMotion(speechRequest)).toBeNull();
    advance(body, 30);
    expect(play).toHaveBeenCalledOnce();
    expect(body.getMotionDirectorSnapshot().history).toEqual([]);
    expect(persona.isActive()).toBe(true);
  });

  it("applies reduced motion to prepared idle clips and updates the current clip's gain", async () => {
    mockPerformanceLibrary();
    const active = playback();
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockResolvedValue(active);
    const { body } = createBody();
    await body.prepareMotionLibrary();
    body.setMotionIntensity(0);
    expect(body.acquireSemanticMotion(speechRequest)).toBeNull();
    advance(body, 30);
    expect(play).not.toHaveBeenCalled();
    body.setMotionIntensity(0.25);
    advance(body, 1.3);
    await flush();
    expect(play).toHaveBeenCalledOnce();
    expect(play.mock.calls[0][1]?.weight).toBeLessThanOrEqual(0.25);
    body.setMotionIntensity(0.5);
    const baseWeight = body.getMotionDirectorSnapshot().lastDecision?.options.weight ?? 0;
    expect(active.setWeight).toHaveBeenCalledWith(baseWeight * 0.5, 350);
  });

  it("fades to the latest reduced-motion gain when that setting changes during loading", async () => {
    mockPerformanceLibrary();
    const pending = deferred<Playback>();
    vi.spyOn(AnimationPlayer.prototype, "play").mockReturnValue(pending.promise);
    const { body } = createBody();
    await body.prepareMotionLibrary();
    advance(body, 1.3);
    body.setMotionIntensity(0.25);
    const active = playback();
    pending.resolve(active);
    await flush();
    const baseWeight = body.getMotionDirectorSnapshot().lastDecision?.options.weight ?? 0;
    expect(active.setWeight).toHaveBeenCalledWith(baseWeight * 0.25, 350);
  });

  it("immediately invalidates pending idle playback when reduced motion is set to zero", async () => {
    mockPerformanceLibrary();
    const pending = deferred<Playback>();
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockReturnValue(pending.promise);
    const { body } = createBody();
    await body.prepareMotionLibrary();
    advance(body, 1.3);
    body.setMotionIntensity(0);
    expect(play.mock.calls[0][1]?.isCurrent?.()).toBe(false);
    const late = playback();
    pending.resolve(late);
    await flush();
    expect(late.cancel).toHaveBeenCalledOnce();
    expect(late.setWeight).not.toHaveBeenCalled();
  });

  it("disabling the library releases owned speech motion while leaving explicit persona motion alone", async () => {
    mockPerformanceLibrary();
    const speech = playback();
    const personaPlayback = playback();
    vi.spyOn(AnimationPlayer.prototype, "play")
      .mockResolvedValueOnce(speech)
      .mockResolvedValueOnce(personaPlayback);
    const { body } = createBody();
    await body.prepareMotionLibrary();
    const handle = body.acquireSemanticMotion(speechRequest);
    await flush();
    body.setMotionLibraryEnabled(false);
    expect(speech.stop).toHaveBeenCalledWith(500);
    expect(handle?.isActive()).toBe(false);
    expect(body.acquireSemanticMotion(speechRequest)).toBeNull();
    const persona = body.acquireMotionSlot({
      source: "persona",
      priority: "persona-handler",
      animation: "anim:persona-owned",
    });
    await flush();
    body.setMotionLibraryEnabled(false);
    expect(personaPlayback.stop).not.toHaveBeenCalled();
    expect(persona.isActive()).toBe(true);
  });

  it("invalidates a pending semantic load when an external animation claim arrives", async () => {
    mockPerformanceLibrary();
    const pending = deferred<Playback>();
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockReturnValue(pending.promise);
    const { body, claims } = createBody();
    await body.prepareMotionLibrary();
    const handle = body.acquireSemanticMotion(speechRequest);
    expect(play.mock.calls[0][1]?.isCurrent?.()).toBe(true);
    claims.claim("animation");
    expect(play.mock.calls[0][1]?.isCurrent?.()).toBe(false);
    advance(body, 1 / 60);
    const late = playback();
    pending.resolve(late);
    await flush();
    expect(late.cancel).toHaveBeenCalledOnce();
    await expect(handle?.completion).resolves.toEqual({ reason: "cancelled" });
  });

  it("keeps the outgoing clip while a replacement loads, then cancels both when ownership ends", async () => {
    const outgoing = playback();
    const incoming = playback();
    const pending = deferred<Playback>();
    const play = vi
      .spyOn(AnimationPlayer.prototype, "play")
      .mockResolvedValueOnce(outgoing)
      .mockReturnValueOnce(pending.promise);
    const { body } = createBody();
    const first = body.acquireMotionSlot({
      source: "idle",
      priority: "idle-fidget",
      animation: "anim:Idle",
    });
    await flush();
    const replacement = body.acquireMotionSlot({
      source: "system",
      priority: "speech-expression",
      animation: "anim:Thankful",
    });
    expect(first.isPreempted()).toBe(true);
    expect(outgoing.stop).not.toHaveBeenCalled();
    expect(outgoing.cancel).not.toHaveBeenCalled();
    expect(play.mock.calls[1][1]?.isCurrent?.()).toBe(true);
    replacement.cancel();
    expect(play.mock.calls[1][1]?.isCurrent?.()).toBe(false);
    expect(outgoing.cancel).toHaveBeenCalledOnce();
    pending.resolve(incoming);
    await flush();
    expect(incoming.cancel).toHaveBeenCalledOnce();
    expect(body.getMotionSnapshot().active).toBeNull();
  });

  it("retires the outgoing clip if a replacement fails, without leaving orphan playback", async () => {
    const outgoing = playback();
    vi.spyOn(AnimationPlayer.prototype, "play")
      .mockResolvedValueOnce(outgoing)
      .mockRejectedValueOnce(new Error("missing replacement"));
    const { body } = createBody();
    body.acquireMotionSlot({ source: "idle", priority: "idle-fidget", animation: "anim:Idle" });
    await flush();
    const replacement = body.acquireMotionSlot({
      source: "system",
      priority: "speech-expression",
      animation: "anim:missing",
    });
    await expect(replacement.completion).resolves.toEqual({ reason: "errored" });
    expect(outgoing.stop).toHaveBeenCalledWith(250);
    expect(body.getMotionSnapshot().active).toBeNull();
  });

  it("prevents ambient selection during speech-owned expression even with no body gesture", async () => {
    mockPerformanceLibrary();
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockResolvedValue(playback());
    const { body } = createBody();
    await body.prepareMotionLibrary();
    const state = body.acquireSpeechStateExpression({ preset: "neutral" });
    advance(body, 30);
    expect(play).not.toHaveBeenCalled();
    state.release();
    advance(body, 2.6);
    expect(play).toHaveBeenCalledOnce();
  });

  it("lets a late utterance release only its preempted gesture, preserving the newer owner", async () => {
    mockPerformanceLibrary();
    const first = playback();
    const second = playback();
    const play = vi
      .spyOn(AnimationPlayer.prototype, "play")
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const { body } = createBody();
    await body.prepareMotionLibrary();
    const adapter = createBodyStateExpressionAdapter(() => body);
    adapter.onCue(cue(), { scheduledForMs: 0, firedAtMs: 0, lateByMs: 0 });
    await flush();
    advance(body, 2.5);
    adapter.onCue(cue({ utteranceId: "u2", gestureIntent: "reassure" }), {
      scheduledForMs: 2_500,
      firedAtMs: 2_500,
      lateByMs: 0,
    });
    await flush();
    expect(play).toHaveBeenCalledTimes(2);
    adapter.onRelease("u1", "completed");
    expect(second.stop).not.toHaveBeenCalled();
    expect(body.getMotionSnapshot().active?.priority).toBe("speech-expression");
    adapter.onRelease("u2", "completed");
    expect(second.stop).toHaveBeenCalledWith(180);
  });

  it("updates a facial cue without aborting the current speech motif during director quiet time", async () => {
    mockPerformanceLibrary();
    const active = playback();
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockResolvedValue(active);
    const { body } = createBody();
    await body.prepareMotionLibrary();
    const adapter = createBodyStateExpressionAdapter(() => body);
    adapter.onCue(cue(), { scheduledForMs: 0, firedAtMs: 0, lateByMs: 0 });
    await flush();
    advance(body, 0.4);
    adapter.onCue(cue({ state: "reassuring", gestureIntent: "reassure" }), {
      scheduledForMs: 400,
      firedAtMs: 400,
      lateByMs: 0,
    });
    expect(play).toHaveBeenCalledOnce();
    expect(active.stop).not.toHaveBeenCalled();
    expect(body.getMotionSnapshot().active?.priority).toBe("speech-expression");
    adapter.onRelease("u1", "completed");
    expect(active.stop).toHaveBeenCalledWith(180);
  });

  it("resumes a recorded idle shortly after a finite speech gesture is released", async () => {
    mockPerformanceLibrary();
    const play = vi
      .spyOn(AnimationPlayer.prototype, "play")
      .mockImplementation(async () => playback());
    const { body } = createBody();
    await body.prepareMotionLibrary();
    const adapter = createBodyStateExpressionAdapter(() => body);
    adapter.onCue(cue(), { scheduledForMs: 0, firedAtMs: 0, lateByMs: 0 });
    await flush();
    advance(body, 1);
    adapter.onRelease("u1", "completed");
    await flush();
    advance(body, 2.6);
    expect(play).toHaveBeenCalledTimes(2);
    expect(play.mock.calls[1][1]).toMatchObject({ loop: true, transition: "matched" });
    expect(body.getMotionSnapshot().active?.priority).toBe("idle-fidget");
  });
});

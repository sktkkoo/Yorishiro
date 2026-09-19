import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import type { Disposable } from "@yorishiro/sdk";
import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBodyStateExpressionAdapter } from "../../runtime/agent-state-expression/body-adapter";
import type { StateExpressionCue } from "../../runtime/agent-state-expression/types";
import { createVoiceStateExpressionBridge } from "../../runtime/agent-state-expression/voice-state-expression-bridge";
import type { ClaimKind, ClaimState } from "../../runtime/ui-claim-state";
import { ZERO_MOUTH } from "../voice/mouth-values";
import { AnimationPlayer } from "./animation-player";
import { Body } from "./index";
import { DEFAULT_MOTION_CATALOG, type MotionCatalogEntry } from "./motion-catalog";
import { MotionDirector } from "./motion-director";
import {
  type CharacterMotionProfile,
  DEFAULT_CHARACTER_MOTION_PROFILE,
  type MotionProgram,
} from "./motion-profile";

// Explicit synthetic profile keeps generic player/priority tests independent of
// production admission. Tests below separately exercise the actual default profile.
const TEST_MOTION_PROFILE: CharacterMotionProfile = {
  ...DEFAULT_CHARACTER_MOTION_PROFILE,
  id: "synthetic-playback-fixture",
  modelSha256: undefined,
  programs: [
    ...DEFAULT_CHARACTER_MOTION_PROFILE.programs,
    {
      review: "synthetic test fixture",
      entry: DEFAULT_MOTION_CATALOG[0],
      role: "ambient",
      composition: { mask: "upper-body", support: "retain-standing", gain: "idle" },
    },
  ],
};

function testProgram(id: string): MotionProgram {
  const program = TEST_MOTION_PROFILE.programs.find((item) => item.entry.id === id);
  if (!program) throw new Error(`Missing test program ${id}`);
  return program;
}

import { OCCASIONAL_IDLE_ANIMATIONS } from "./occasional-idle-selector";

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
    stopped: completion.promise,
    setWeight: vi.fn(),
    stop: vi.fn(async () => completion.resolve()),
    cancel: vi.fn(() => completion.resolve()),
  } satisfies Playback;
}

function createBody(
  modelSha256?: string,
  motionProfile: CharacterMotionProfile = TEST_MOTION_PROFILE,
) {
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
  const body = new Body(vrm, undefined, claims, { modelSha256, motionProfile });
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

async function createReviewedSpeechBody() {
  mockPerformanceLibrary();
  const entry: MotionCatalogEntry = {
    ...DEFAULT_MOTION_CATALOG[0],
    animation: "reviewed-short.vrma",
    contexts: ["speech"],
    intents: ["celebrate"],
    playback: "once",
    finishAfterSpeech: true,
    speed: 1,
  };
  const fixture = createBody(undefined, {
    ...TEST_MOTION_PROFILE,
    programs: [
      {
        entry,
        role: "speech",
        review: "synthetic reviewed recovery",
        composition: { mask: "upper-body", support: "retain-standing", gain: "speech" },
      },
    ],
  });
  const { body, vrm } = fixture;
  const player = (body as unknown as { animationPlayer: AnimationPlayer }).animationPlayer;
  const cache = (player as unknown as { clipCache: Map<string, THREE.AnimationClip> }).clipCache;
  const arm = vrm.humanoid.getNormalizedBoneNode("leftLowerArm");
  if (!arm) throw new Error("test arm required");
  cache.set(
    entry.animation,
    new THREE.AnimationClip(entry.animation, 3, [
      new THREE.QuaternionKeyframeTrack(
        `${arm.name}.quaternion`,
        [0, 1.5, 3],
        [0, 0, 0, 1, Math.sin(0.2), 0, 0, Math.cos(0.2), 0, 0, 0, 1],
      ),
    ]),
  );
  // Only the physical entry evidence is mocked. Selection, scheduler ownership,
  // clip clock, authored completion, and Body updates are real.
  (body as unknown as { motionDirector: MotionDirector }).motionDirector = new MotionDirector({
    catalog: [entry],
    evaluateTransition: (animation, options) => player.evaluateTransition(animation, options),
  });
  await body.prepareMotionLibrary();
  return { ...fixture, entry, adapter: createBodyStateExpressionAdapter(() => body) };
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
  it("uses isolated character program sets without changing another Body's admission", async () => {
    mockPerformanceLibrary();
    vi.spyOn(AnimationPlayer.prototype, "play").mockImplementation(async () => playback());
    const program = (id: string): MotionProgram => ({
      review: "synthetic character review",
      role: "speech",
      composition: { mask: "upper-body", support: "retain-standing", gain: "speech" },
      entry: {
        ...DEFAULT_MOTION_CATALOG[0],
        id,
        animation: `anim:${id}`,
        contexts: ["speech"],
        intents: ["agree"],
      },
    });
    const first = createBody(undefined, {
      ...TEST_MOTION_PROFILE,
      programs: [program("character-a")],
    }).body;
    const second = createBody(undefined, {
      ...TEST_MOTION_PROFILE,
      programs: [program("character-b")],
    }).body;
    await first.prepareMotionLibrary();
    await second.prepareMotionLibrary();
    first.acquireSemanticMotion(speechRequest);
    second.acquireSemanticMotion(speechRequest);
    await flush();
    expect(first.getMotionSnapshot().active?.animation).toBe("anim:character-a");
    expect(second.getMotionSnapshot().active?.animation).toBe("anim:character-b");
    expect(
      first
        .getMotionDirectorSnapshot()
        .lastDecision?.candidates.map((candidate) => candidate.animation),
    ).toEqual(["anim:character-a"]);
  });

  it("retries a prepared speech program after a temporary commit failure without poisoning its history", async () => {
    mockPerformanceLibrary();
    const program = DEFAULT_CHARACTER_MOTION_PROFILE.programs.find(
      (candidate) => candidate.entry.id === "speech-chat",
    );
    if (!program) throw new Error("speech fixture missing");
    const play = vi
      .spyOn(AnimationPlayer.prototype, "play")
      .mockRejectedValueOnce(new Error("temporary entry mismatch"))
      .mockResolvedValueOnce(playback());
    const { body } = createBody(undefined, { ...TEST_MOTION_PROFILE, programs: [program] });
    await body.prepareMotionLibrary();
    body.setMotionConversationPhase("assistant-speaking");
    advance(body, 1.3);
    await flush();
    expect(body.getMotionDirectorSnapshot().history).toEqual([]);
    advance(body, 2.6);
    await flush();
    expect(play).toHaveBeenCalledTimes(2);
    expect(body.getMotionSnapshot().active?.animation).toBe(program.entry.animation);
  });

  it.each([
    "interrupt",
    "zero",
    "disable",
    "listening",
  ] as const)("still stops retained automatic playback after a failed replacement via %s", async (stop) => {
    mockPerformanceLibrary();
    const outgoing = playback();
    vi.spyOn(AnimationPlayer.prototype, "play")
      .mockResolvedValueOnce(outgoing)
      .mockRejectedValueOnce(new Error("missing"));
    const { body } = createBody();
    await body.prepareMotionLibrary();
    advance(body, 1.3);
    await flush();
    const replacement = body.acquireMotionSlot({
      source: "system",
      priority: "speech-expression",
      animation: "missing",
    });
    await expect(replacement.completion).resolves.toEqual({ reason: "errored" });
    expect(outgoing.stop).not.toHaveBeenCalled();
    if (stop === "interrupt") body.createCharacterAPI().interrupt();
    else if (stop === "zero") body.setMotionIntensity(0);
    else if (stop === "disable") body.setMotionLibraryEnabled(false);
    else body.setMotionConversationPhase("user-speaking");
    expect(outgoing.stop).toHaveBeenCalledExactlyOnceWith(
      stop === "interrupt" ? 200 : stop === "zero" ? 350 : stop === "disable" ? 500 : 650,
    );
  });

  it("stops retained automatic talking on listening while a manual replacement is still loading", async () => {
    mockPerformanceLibrary();
    const outgoing = playback();
    const incoming = deferred<Playback>();
    const manualPlayback = playback();
    vi.spyOn(AnimationPlayer.prototype, "play")
      .mockResolvedValueOnce(outgoing)
      .mockReturnValueOnce(incoming.promise);
    const { body } = createBody();
    await body.prepareMotionLibrary();
    body.setMotionConversationPhase("assistant-speaking");
    advance(body, 1.3);
    await flush();
    const manual = body.acquireMotionSlot({
      source: "mcp",
      priority: "mcp-conscious",
      animation: "manual",
    });
    body.setMotionConversationPhase("user-speaking");
    expect(outgoing.stop).toHaveBeenCalledExactlyOnceWith(650);
    incoming.resolve(manualPlayback);
    await flush();
    expect(manual.isActive()).toBe(true);
    expect(manualPlayback.cancel).not.toHaveBeenCalled();
  });

  it("does not consume semantic history while physical whole-body recovery denies composition", async () => {
    mockPerformanceLibrary();
    const { body } = createBody();
    const completion = deferred<void>();
    const stopped = deferred<void>();
    vi.spyOn(AnimationPlayer.prototype, "play").mockImplementationOnce(async (_ref, options) => {
      await Promise.resolve();
      options?.onCommit?.();
      return { ...playback(), completion: completion.promise, stopped: stopped.promise };
    });
    await body.prepareMotionLibrary();
    const manual = body.acquireMotionSlot({
      source: "mcp",
      priority: "mcp-conscious",
      animation: "manual",
    });
    await flush();
    completion.resolve();
    await manual.completion;
    expect(body.getRecordedBodySnapshot().performanceOwnsBody).toBe(true);
    expect(body.acquireSemanticMotion(speechRequest)).toBeNull();
    expect(body.getMotionDirectorSnapshot().history).toEqual([]);
    stopped.resolve();
    await flush();
    expect(body.acquireSemanticMotion(speechRequest)).not.toBeNull();
  });

  it("retains a preempted posture's original deadline when its replacement fails", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    mockPerformanceLibrary();
    vi.mocked(AnimationPlayer.prototype.evaluateTransition).mockImplementation((animation) =>
      animation === "anim:VRMA_06_HandOnHip" ? { cost: 0, startTimeSec: 0 } : null,
    );
    const { sha } = mockStandingBase();
    const outgoing = playback();
    vi.spyOn(AnimationPlayer.prototype, "play")
      .mockImplementationOnce(async (_ref, options) => {
        await Promise.resolve();
        options?.onCommit?.();
        return outgoing;
      })
      .mockRejectedValueOnce(new Error("missing replacement"));
    const { body } = createBody(sha, { ...DEFAULT_CHARACTER_MOTION_PROFILE, modelSha256: sha });
    await body.initializeRecordedBody();
    await body.prepareMotionLibrary();
    advance(body, 15.1);
    await flush();
    advance(body, 4);
    const replacement = body.acquireMotionSlot({
      source: "mcp",
      priority: "mcp-conscious",
      animation: "missing",
    });
    await expect(replacement.completion).resolves.toEqual({ reason: "errored" });
    advance(body, 3);
    expect(outgoing.stop).not.toHaveBeenCalled();
    advance(body, 1.1);
    expect(outgoing.stop).toHaveBeenCalledExactlyOnceWith(800);
  });

  it("keeps the authored entry fade when intensity changes before the player commits", async () => {
    mockPerformanceLibrary();
    const program = DEFAULT_CHARACTER_MOTION_PROFILE.programs.find(
      (candidate) => candidate.entry.id === "speech-chat",
    );
    if (!program) throw new Error("speech profile fixture missing");
    const { body, vrm } = createBody(undefined, { ...TEST_MOTION_PROFILE, programs: [program] });
    const player = (body as unknown as { animationPlayer: AnimationPlayer }).animationPlayer;
    const cache = (player as unknown as { clipCache: Map<string, THREE.AnimationClip> }).clipCache;
    const arm = vrm.humanoid.getNormalizedBoneNode("leftLowerArm");
    if (!arm) throw new Error("arm fixture missing");
    cache.set(
      program.entry.animation,
      new THREE.AnimationClip("conversation", 4, [
        new THREE.QuaternionKeyframeTrack(
          `${arm.name}.quaternion`,
          [0, 4],
          [0, 0, 0, 1, 0, 0, 0, 1],
        ),
      ]),
    );
    await body.prepareMotionLibrary();
    body.setMotionConversationPhase("assistant-speaking");
    advance(body, 1.3);
    body.setMotionIntensity(0.5);
    await flush();
    advance(body, 0.35);
    expect(player.getTotalEffectiveWeight()).toBeGreaterThan(0);
    expect(player.getTotalEffectiveWeight()).toBeLessThan(0.425 * 0.5);
    advance(body, 0.9);
    expect(player.getTotalEffectiveWeight()).toBeCloseTo(0.425);
  });

  it("default admission preloads lower Idle independently and keeps supported listening when no upper candidate exists", async () => {
    const preload = mockPerformanceLibrary();
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockResolvedValue(playback());
    const { sha, base } = mockStandingBase();
    const { body } = createBody(sha, { ...DEFAULT_CHARACTER_MOTION_PROFILE, modelSha256: sha });
    await body.prepareMotionLibrary();
    await body.initializeRecordedBody();
    body.setMotionConversationPhase("user-speaking");
    advance(body, 10);
    await flush();
    expect(play).not.toHaveBeenCalled();
    expect(preload).toHaveBeenCalledWith("anim:Idle", { mask: "lower-body", loop: true });
    expect(
      preload.mock.calls.some(
        ([animation, options]) => animation === "anim:Idle" && options?.mask === "upper-body",
      ),
    ).toBe(false);
    expect(preload.mock.calls.some(([animation]) => animation.includes("Shrugging"))).toBe(false);
    expect(body.getRecordedBodySnapshot().active?.id).toBe("standing");
    expect(base.stop).not.toHaveBeenCalled();
    expect(base.cancel).not.toHaveBeenCalled();
    expect(
      body.acquireSemanticMotion({ ...speechRequest, intent: "uncertain" })?.animation,
    ).not.toContain("Shrugging");
  });

  it("keeps supporting motion during a failed full-body load and commits ownership only when a replacement succeeds", async () => {
    const { sha, base } = mockStandingBase();
    const { body } = createBody(sha);
    await body.initializeRecordedBody();
    const pending = deferred<Playback>();
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockReturnValueOnce(pending.promise);
    const request = body.acquireMotionSlot({
      source: "mcp",
      priority: "mcp-conscious",
      animation: "missing-full-body",
    });
    advance(body, 1);
    expect(base.stop).not.toHaveBeenCalled();
    expect(body.getRecordedBodySnapshot().performanceOwnsBody).toBe(false);
    pending.reject(new Error("missing asset"));
    await expect(request.completion).resolves.toEqual({ reason: "errored" });
    expect(base.stop).not.toHaveBeenCalled();
    expect(body.getRecordedBodySnapshot().active?.id).toBe("standing");

    const completion = deferred<void>();
    const stopped = deferred<void>();
    const physical = { ...playback(), completion: completion.promise, stopped: stopped.promise };
    play.mockImplementationOnce(async (_ref, options) => {
      options?.onCommit?.();
      return physical;
    });
    const valid = body.acquireMotionSlot({
      source: "mcp",
      priority: "mcp-conscious",
      animation: "full-body",
      options: { fadeInMs: 0 },
    });
    await flush();
    expect(base.cancel).toHaveBeenCalledOnce();
    expect(body.getRecordedBodySnapshot().performanceOwnsBody).toBe(true);
    completion.resolve();
    await expect(valid.completion).resolves.toEqual({ reason: "completed" });
    expect(body.getRecordedBodySnapshot().composition.support.recorded).toBe(false);
    expect(body.getRecordedBodySnapshot().performanceOwnsBody).toBe(true);
    stopped.resolve();
    await flush();
    expect(body.getRecordedBodySnapshot().performanceOwnsBody).toBe(false);
    expect(body.getRecordedBodySnapshot().composition.support.recorded).toBe(true);
  });

  it("lets a real short clip return after Kyoko's measured single-sentence audio end without idle stealing it", async () => {
    vi.useFakeTimers();
    try {
      const { body, entry, adapter } = await createReviewedSpeechBody();
      let now = 0;
      const bridge = createVoiceStateExpressionBridge(adapter, {
        now: () => now,
        setTimeout: (callback, delay) => setTimeout(callback, delay),
        clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      });
      const acquire = vi.spyOn(body, "acquireSemanticMotion");
      const tick = async (durationMs: number) => {
        for (let remaining = durationMs; remaining > 0; ) {
          const deltaMs = Math.min(1000 / 60, remaining);
          now += deltaMs;
          vi.advanceTimersByTime(deltaMs);
          body.update(deltaMs / 1000, now / 1000);
          await flush();
          remaining -= deltaMs;
        }
      };
      bridge.onPrepared("kyoko", "成功しましたね。");
      await tick(5_000);
      expect(acquire).not.toHaveBeenCalled();
      bridge.onStarted("kyoko", now);
      // Recorded locally: 1,216.625 ms WAV, resolver cue at 650 ms.
      await tick(1_216.625);
      const handle = acquire.mock.results[0]?.value;
      expect(handle?.finishAfterSpeech).toBe(true);
      bridge.onEnded("kyoko", "completed");
      await tick(2_000);
      expect(body.getMotionSnapshot().active?.animation).toBe(entry.animation);
      expect(handle?.isActive()).toBe(true);
      await tick(500);
      await expect(handle?.completion).resolves.toEqual({ reason: "completed" });
      expect(body.getMotionSnapshot().active).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    "user-speaking",
    "interrupted",
    "manual",
    "claim",
    "new-speech",
    "stop",
  ] as const)("still preempts a real reviewed recovery on %s", async (action) => {
    const { body, claims, entry, adapter } = await createReviewedSpeechBody();
    adapter.onConversationPhaseChange?.("assistant-speaking");
    const acquire = vi.spyOn(body, "acquireSemanticMotion");
    adapter.onCue(
      { utteranceId: "short", atMs: 0, state: "appreciative", gestureIntent: "celebrate" },
      { scheduledForMs: 0, firedAtMs: 0, lateByMs: 0 },
    );
    await flush();
    const handle = acquire.mock.results[0].value;
    advance(body, 0.5);
    adapter.onRelease("short", "completed");
    adapter.onConversationPhaseChange?.("idle");
    expect(handle?.isActive()).toBe(true);
    if (action === "manual") {
      body.acquireMotionSlot({
        source: "mcp",
        priority: "mcp-conscious",
        animation: entry.animation,
      });
    } else if (action === "claim") {
      claims.claim("animation");
      advance(body, 1 / 60);
    } else if (action === "new-speech") {
      adapter.onConversationPhaseChange?.("assistant-responding");
    } else if (action === "stop") {
      adapter.onRelease("short", "cancelled");
    } else {
      adapter.onConversationPhaseChange?.(action);
    }
    await expect(handle?.completion).resolves.toEqual({
      reason: action === "manual" ? "preempted" : "cancelled",
    });
    expect(handle?.isActive()).toBe(false);
  });

  it("keeps supporting legs through terminal activity and upper-body persona reactions, then yields to a claim", async () => {
    const { sha, base } = mockStandingBase();
    const { body, claims } = createBody(sha);
    body.setMotionIntensity(0.95);
    await body.initializeRecordedBody();
    expect(body.getRecordedBodySnapshot().active?.id).toBe("standing");
    expect(base.setUpperWeight).toHaveBeenLastCalledWith(0.475, 0);
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
      weight: 0.475,
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

  it("keeps a finite stretch alive over the recorded legs and yields when listening begins", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    mockPerformanceLibrary();
    const ref = "/animations/mixamo/Warrior Stretch.vrma";
    vi.mocked(AnimationPlayer.prototype.evaluateTransition).mockImplementation((animation) =>
      animation === ref ? { cost: 0.14, startTimeSec: 0 } : null,
    );
    const { sha, base } = mockStandingBase();
    const stretch = playback();
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockResolvedValue(stretch);
    const { body } = createBody(sha);
    await body.initializeRecordedBody();
    await body.prepareMotionLibrary();
    advance(body, 91);
    await flush();
    expect(play).toHaveBeenCalledOnce();
    expect(play.mock.calls[0][0]).toBe(ref);
    expect(play.mock.calls[0][1]).toMatchObject({ loop: false, mask: "upper-body", speed: 1 });
    expect(play.mock.calls[0][1]?.maxDurationMs).toBeUndefined();
    advance(body, 1);
    expect(stretch.stop).not.toHaveBeenCalled();
    expect(base.stop).not.toHaveBeenCalled();
    expect(base.cancel).not.toHaveBeenCalled();
    body.setMotionConversationPhase("user-speaking");
    advance(body, 0.1);
    await flush();
    expect(stretch.stop).toHaveBeenCalledExactlyOnceWith(800);
    expect(body.getRecordedBodySnapshot().active?.id).toBe("standing");
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
      weight: 0.475,
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

  it("bounds default HandOnHip and waits its full cooldown without upper Idle fallback", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    mockPerformanceLibrary();
    vi.mocked(AnimationPlayer.prototype.evaluateTransition).mockImplementation((animation) =>
      animation === "anim:VRMA_06_HandOnHip" ? { cost: 0, startTimeSec: 0 } : null,
    );
    const { sha, base, playBase } = mockStandingBase();
    const first = playback();
    const second = playback();
    const play = vi
      .spyOn(AnimationPlayer.prototype, "play")
      .mockImplementationOnce(async (_ref, options) => {
        await Promise.resolve();
        options?.onCommit?.();
        return first;
      })
      .mockImplementationOnce(async (_ref, options) => {
        await Promise.resolve();
        options?.onCommit?.();
        return second;
      });
    const { body } = createBody(sha, { ...DEFAULT_CHARACTER_MOTION_PROFILE, modelSha256: sha });
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

    advance(body, 171);
    expect(play).toHaveBeenCalledOnce();
    advance(body, 3);
    await flush();
    expect(play).toHaveBeenCalledTimes(2);
    expect(play.mock.calls[1][0]).toBe("anim:VRMA_06_HandOnHip");
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

  it("makes cold Normal quiet, restores former Normal at Lively and preserves Over without restarting the base", async () => {
    const { sha, base, playBase } = mockStandingBase();
    const { body } = createBody(sha);
    await body.initializeRecordedBody();
    expect(body.getRecordedBodySnapshot()).toMatchObject({ intensity: 1, effectiveIntensity: 0.5 });
    expect(base.setUpperWeight).toHaveBeenLastCalledWith(0.5, 0);
    expect(base.setAxialStrength).toHaveBeenLastCalledWith({ torso: 0.09, head: 0.03 }, 0);
    body.setMotionIntensity(2);
    advance(body, 2);
    expect(body.getRecordedBodySnapshot()).toMatchObject({ intensity: 2, effectiveIntensity: 1 });
    expect(base.setUpperWeight).toHaveBeenLastCalledWith(1, 350);
    expect(base.setAxialStrength.mock.lastCall?.[0]).toEqual({
      torso: expect.closeTo(0.18, 5),
      head: expect.closeTo(0.06, 5),
    });
    const beforeOver = { ...base.setAxialStrength.mock.lastCall?.[0] };
    body.setMotionIntensity(3);
    body.update(0, 0);
    expect(base.setAxialStrength.mock.lastCall?.[0]).toEqual(beforeOver);
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
      torso: expect.closeTo(0.0855, 5),
      head: expect.closeTo(0.0285, 5),
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
    expect(player.getFoundationEffectiveWeight()).toBeCloseTo(0.5);
    const beforeSpeech = leg.rotation.x;
    body.acquireMotionSlot({
      source: "system",
      priority: "speech-expression",
      animation: "anim:upper",
      options: { mask: "upper-body", loop: true, weight: 1, fadeInMs: 200 },
    });
    await flush();
    advance(body, 1);
    expect(player.getFoundationEffectiveWeight()).toBeCloseTo(0.5);
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

  it.each([
    [1, "baseline"],
    [2, "baseline"],
    [1, "semantic"],
    [2, "semantic"],
  ] as const)("uses the same authored speech strength at setting %s for %s playback and entry scoring", async (setting, mode) => {
    mockPerformanceLibrary();
    const evaluate = vi.mocked(AnimationPlayer.prototype.evaluateTransition);
    const active = playback();
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockResolvedValue(active);
    const { body } = createBody();
    await body.prepareMotionLibrary();
    body.setMotionIntensity(setting);
    if (mode === "baseline") {
      body.setMotionConversationPhase("assistant-speaking");
      advance(body, 1.3);
    } else {
      body.acquireSemanticMotion({ ...speechRequest, intent: "explain" });
    }
    await flush();
    expect(play).toHaveBeenCalledOnce();
    const [animation, options] = play.mock.calls[0];
    expect(options?.weight).toBe(setting === 1 ? 0.85 : 1);
    expect(evaluate).toHaveBeenCalledWith(
      animation,
      expect.objectContaining({ weight: options?.weight }),
    );
    body.setMotionIntensity(setting === 1 ? 2 : 1);
    expect(active.setWeight).toHaveBeenLastCalledWith(setting === 1 ? 1 : 0.85, 350);
  });

  it("preserves the speech gain curve when the setting changes during loading", async () => {
    mockPerformanceLibrary();
    const pending = deferred<Playback>();
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockReturnValue(pending.promise);
    const { body } = createBody();
    await body.prepareMotionLibrary();
    body.setMotionIntensity(0.5);
    body.setMotionConversationPhase("assistant-speaking");
    advance(body, 1.3);
    expect(play.mock.calls[0][1]?.weight).toBe(0.425);
    body.setMotionIntensity(2);
    const active = playback();
    pending.resolve(active);
    await flush();
    expect(active.setWeight).toHaveBeenLastCalledWith(1, 350);
    body.setMotionIntensity(1);
    expect(active.setWeight).toHaveBeenLastCalledWith(0.85, 350);
  });

  const performanceCases = [
    ...["speech-appreciate", "speech-chat", "speech-present"].map((id) => {
      const program = testProgram(id);
      return { program, standard: program.entry.weight };
    }),
    {
      program: testProgram("idle-balance"),
      standard: 0.45,
    },
  ];

  it.each(
    performanceCases.flatMap(({ program, standard }) =>
      [0, 0.5, 1, 1.5, 2, 3].map((setting) => ({ program, standard, setting })),
    ),
  )("scores and plays $program.entry.id at public setting $setting with the same weight", async ({
    program,
    standard,
    setting,
  }) => {
    mockPerformanceLibrary();
    const evaluate = vi.mocked(AnimationPlayer.prototype.evaluateTransition);
    const active = playback();
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockResolvedValue(active);
    const { body } = createBody(undefined, { ...TEST_MOTION_PROFILE, programs: [program] });
    await body.prepareMotionLibrary();
    body.setMotionIntensity(setting);
    if (program.role === "speech") {
      body.acquireSemanticMotion({
        ...speechRequest,
        intent: program.entry.intents[0],
        intensity: 0.5,
      });
    } else {
      advance(body, 1.3);
    }
    await flush();
    if (setting === 0) {
      expect(play).not.toHaveBeenCalled();
      return;
    }
    const expected =
      setting <= 1 ? standard * setting : standard + (1 - standard) * Math.min(1, setting - 1);
    expect(play).toHaveBeenCalledOnce();
    const [animation, options] = play.mock.calls[0];
    expect(animation).toBe(program.entry.animation);
    expect(options?.weight).toBeCloseTo(expected);
    expect(options?.speed).toBe(program.entry.speed);
    expect(options?.requireCompatibleEntry).toBe(true);
    expect(options?.getCurrentWeight?.()).toBeCloseTo(expected);
    expect(evaluate).toHaveBeenCalledWith(
      animation,
      expect.objectContaining({ weight: options?.weight }),
    );
    body.setMotionIntensity(2);
    expect(active.setWeight).toHaveBeenLastCalledWith(1, 350);
    body.setMotionIntensity(1);
    expect(active.setWeight).toHaveBeenLastCalledWith(standard, 350);
  });

  it.each([
    0, 0.5, 1,
  ])("reaches authored weight at Lively even with finite semantic intensity %s", async (intensity) => {
    mockPerformanceLibrary();
    const program = testProgram("speech-appreciate");
    const active = playback();
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockResolvedValue(active);
    const { body } = createBody(undefined, { ...TEST_MOTION_PROFILE, programs: [program] });
    await body.prepareMotionLibrary();
    body.setMotionIntensity(2);
    body.acquireSemanticMotion({ ...speechRequest, intensity });
    await flush();
    expect(play.mock.calls[0][1]?.weight).toBe(1);
    body.setMotionIntensity(1);
    expect(active.setWeight).toHaveBeenLastCalledWith(0.6 * (0.65 + intensity * 0.7), 350);
  });

  it("keeps a reviewed ceiling through admission, pending commit and live gain changes", async () => {
    mockPerformanceLibrary();
    const source = TEST_MOTION_PROFILE.programs[0];
    const program = { ...source, entry: { ...source.entry, maxWeight: 0.8 } };
    const pending = deferred<Playback>();
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockReturnValue(pending.promise);
    const { body } = createBody(undefined, { ...TEST_MOTION_PROFILE, programs: [program] });
    await body.prepareMotionLibrary();
    body.acquireSemanticMotion(speechRequest);
    expect(play.mock.calls[0][1]?.weight).toBe(0.6);
    body.setMotionIntensity(2);
    expect(play.mock.calls[0][1]?.getCurrentWeight?.()).toBe(0.8);
    const active = playback();
    pending.resolve(active);
    await flush();
    // The player already sampled the latest weight at commit; no second fade reset.
    expect(active.setWeight).not.toHaveBeenCalled();
    body.setMotionIntensity(3);
    expect(active.setWeight).toHaveBeenLastCalledWith(0.8, 350);
    body.setMotionIntensity(1);
    expect(active.setWeight).toHaveBeenLastCalledWith(0.6, 350);
  });

  it("does not force a full-weight Lively performance through a rejected entry", async () => {
    mockPerformanceLibrary();
    const evaluate = vi.mocked(AnimationPlayer.prototype.evaluateTransition).mockReturnValue(null);
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockResolvedValue(playback());
    const program = testProgram("speech-appreciate");
    const { body } = createBody(undefined, { ...TEST_MOTION_PROFILE, programs: [program] });
    await body.prepareMotionLibrary();
    body.setMotionIntensity(2);
    expect(body.acquireSemanticMotion(speechRequest)).toBeNull();
    expect(evaluate).toHaveBeenCalledWith(
      program.entry.animation,
      expect.objectContaining({ weight: 1 }),
    );
    expect(play).not.toHaveBeenCalled();
  });

  it.each([
    0, 0.5, 1, 2, 3,
  ])("uses matching full-weight admission and playback for a timed posture at setting %s", async (setting) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    mockPerformanceLibrary();
    const evaluate = vi.mocked(AnimationPlayer.prototype.evaluateTransition);
    const { sha, base } = mockStandingBase();
    const program = testProgram("idle-rest-hand");
    const active = playback();
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockResolvedValue(active);
    const { body } = createBody(sha, { ...TEST_MOTION_PROFILE, programs: [program] });
    await body.initializeRecordedBody();
    await body.prepareMotionLibrary();
    body.setMotionIntensity(setting);
    advance(body, 15.1);
    await flush();
    if (setting === 0) {
      expect(play).not.toHaveBeenCalled();
      return;
    }
    const expected = setting <= 1 ? 0.425 * setting : 1;
    expect(play).toHaveBeenCalledOnce();
    expect(play.mock.calls[0][1]?.weight).toBe(expected);
    expect(evaluate).toHaveBeenCalledWith(
      program.entry.animation,
      expect.objectContaining({ weight: expected }),
    );
    body.setMotionIntensity(2);
    expect(active.setWeight).toHaveBeenLastCalledWith(1, 350);
    body.setMotionIntensity(1);
    expect(active.setWeight).toHaveBeenLastCalledWith(0.425, 350);
    expect(base.stop).not.toHaveBeenCalled();
    expect(base.cancel).not.toHaveBeenCalled();
  });

  it("preserves an explicit manual weight even for an automatic catalog animation", async () => {
    mockPerformanceLibrary();
    const active = playback();
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockResolvedValue(active);
    const { body } = createBody();
    body.setMotionIntensity(2);
    body.acquireMotionSlot({
      source: "mcp",
      priority: "mcp-conscious",
      animation: "anim:Thankful",
      options: { weight: 0.399 },
    });
    await flush();
    expect(play.mock.calls[0][1]?.weight).toBe(0.399);
    expect(play.mock.calls[0][1]?.getCurrentWeight).toBeUndefined();
    body.setMotionIntensity(3);
    body.setMotionIntensity(0.5);
    expect(active.setWeight).not.toHaveBeenCalled();
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
      1 +
        DEFAULT_MOTION_CATALOG.length +
        DEFAULT_MOTION_CATALOG.filter(
          (entry) => entry.intents.includes("explain") && entry.playback !== "once",
        ).length +
        OCCASIONAL_IDLE_ANIMATIONS.length,
    );
    expect(preload).toHaveBeenCalledWith("anim:Idle", { mask: "upper-body", loop: true });
    expect(preload).toHaveBeenCalledWith("/animations/recorded-idle/survey.vrma", {
      mask: "upper-body",
      loop: false,
    });
    body.setMotionConversationPhase("assistant-speaking");
    advance(body, 1.3);
    await flush();
    expect(play).toHaveBeenCalledOnce();
    expect(play.mock.calls[0][0]).not.toBe("anim:Idle");
    expect(play.mock.calls[0][1]).toMatchObject({
      loop: true,
      mask: "upper-body",
      transition: "matched",
    });
    expect(play.mock.calls[0][1]?.weight).toBeGreaterThanOrEqual(0.425);
    // Resetting the weight here would erase the player's in-progress fade ramp.
    expect(active.setWeight).not.toHaveBeenCalled();
    advance(body, 10);
    expect(play).toHaveBeenCalledOnce();
  });

  it("prepares only the finite variant of reviewed once-only idle and explanation entries", async () => {
    const once = {
      ...DEFAULT_MOTION_CATALOG[0],
      animation: "anim:reviewed-once",
      playback: "once" as const,
      contexts: ["idle", "speech"] as const,
      intents: ["neutral", "explain"] as const,
    };
    const preload = vi.spyOn(AnimationPlayer.prototype, "preload").mockResolvedValue(true);
    const { body } = createBody(undefined, {
      ...TEST_MOTION_PROFILE,
      programs: [
        {
          entry: once,
          role: "speech",
          review: "synthetic once fixture",
          composition: { mask: "upper-body", support: "retain-standing", gain: "speech" },
        },
      ],
    });
    await body.prepareMotionLibrary();
    expect(preload.mock.calls.filter(([animation]) => animation === once.animation)).toEqual([
      [once.animation, { mask: "upper-body", loop: false }],
    ]);
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
    expect(active.setWeight).toHaveBeenCalledWith(baseWeight * 0.25, 350);
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
    expect(active.setWeight).toHaveBeenCalledWith(baseWeight * 0.125, 350);
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

  it("preserves the outgoing clip if a replacement fails and still yields it to an animation claim", async () => {
    const outgoing = playback();
    vi.spyOn(AnimationPlayer.prototype, "play")
      .mockResolvedValueOnce(outgoing)
      .mockRejectedValueOnce(new Error("missing replacement"));
    const { body, claims } = createBody();
    body.acquireMotionSlot({ source: "idle", priority: "idle-fidget", animation: "anim:Idle" });
    await flush();
    const replacement = body.acquireMotionSlot({
      source: "system",
      priority: "speech-expression",
      animation: "anim:missing",
    });
    await expect(replacement.completion).resolves.toEqual({ reason: "errored" });
    expect(outgoing.stop).not.toHaveBeenCalled();
    expect(outgoing.cancel).not.toHaveBeenCalled();
    claims.claim("animation");
    body.update(1 / 60, 1);
    expect(outgoing.cancel).toHaveBeenCalledOnce();
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

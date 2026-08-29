/**
 * Body primitive — unit tests for VRM-independent core logic.
 *
 * Tests ExpressionManager (weight budget), EyeSystem (idle + override),
 * BlinkSystem (blink timing), and utility functions.
 */

import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import type { Disposable } from "@yorishiro/sdk";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import type { ClaimKind, ClaimState } from "../../runtime/ui-claim-state";
import type { AnimationPlayer } from "./animation-player";
import type { BeatTarget } from "./beat-types";
import { BlinkSystem } from "./blink-system";
import { CursorAttentionSystem } from "./cursor-attention";
import type { ExpressionIntentArbiter } from "./expression-intent-arbiter";
import {
  ExpressionManager,
  ExpressionSinkTracker,
  expressionTargetToName,
} from "./expression-manager";
import { EyeSystem, gazeTargetToAngles } from "./eye-system";
import {
  IdleMicroexpressionSystem,
  MICRO_BROW_POOL,
  MICRO_EYE_POOL,
  MICRO_MORPH_POOL,
  MICRO_MOUTH_POOL,
} from "./idle-microexpression-system";
import { IdleSquintSystem } from "./idle-squint-system";
import { Body } from "./index";

function mockBodyVrm(): {
  readonly vrm: VRM;
  readonly getBone: (name: VRMHumanBoneName) => THREE.Object3D;
} {
  const bones = new Map<VRMHumanBoneName, THREE.Object3D>();
  const getBone = (name: VRMHumanBoneName): THREE.Object3D => {
    let bone = bones.get(name);
    if (!bone) {
      bone = new THREE.Object3D();
      bones.set(name, bone);
    }
    return bone;
  };
  const scene = new THREE.Object3D();
  const vrm = {
    meta: { metaVersion: "1" },
    scene,
    humanoid: {
      resetNormalizedPose: () => {},
      getNormalizedBoneNode: getBone,
    },
    expressionManager: {
      getExpression: () => null,
      setValue: () => {},
      update: () => {},
    },
    lookAt: {
      yaw: 0,
      pitch: 0,
      applier: { applyYawPitch: () => {} },
    },
    update: () => {},
  } as unknown as VRM;
  return { vrm, getBone };
}

function mockClaimState(): ClaimState {
  const claimed = new Set<ClaimKind>();
  return {
    isClaimed: (kind) => claimed.has(kind),
    claim: (kind): Disposable => {
      claimed.add(kind);
      return { dispose: () => claimed.delete(kind) };
    },
    releaseAll: () => claimed.clear(),
  };
}

function beatTargetOf(body: Body): BeatTarget {
  return (body as unknown as { buildBeatTarget(): BeatTarget }).buildBeatTarget();
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// ─── Body beat target wiring ─────────────────────────────

describe("Body beat target wiring", () => {
  it("beat glance は triggerGlance 経由で小振幅でも idle では頭を連れる", () => {
    const { vrm, getBone } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    beatTargetOf(body).glance(0.12, 0, 0.6);

    for (let t = 0; t < 1; t += 1 / 60) body.update(1 / 60, t);

    expect(Math.abs(getBone("head").rotation.y)).toBeGreaterThan(0.005);
  });

  it("reading 中の beat glance は dead-zone を守り、頭を連れない", () => {
    const { vrm, getBone } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    body.setState("reading");
    beatTargetOf(body).glance(0.12, 0, 0.6);

    for (let t = 0; t < 1; t += 1 / 60) body.update(1 / 60, t);

    expect(Math.abs(getBone("head").rotation.y)).toBeLessThan(0.001);
  });
});

describe("Body lip sync sampling", () => {
  it("inactive source では per-frame sampleMouth を呼ばない", () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    const sampleMouth = vi.fn(() => ({ aa: 1, ih: 0, ou: 0, ee: 0, oh: 0 }));

    body.setLipSyncSource({
      isMouthActive: () => false,
      sampleMouth,
    });
    body.update(1 / 60, 0);

    expect(sampleMouth).not.toHaveBeenCalled();
  });

  it("lip sync 信号は slot 由来の同名 viseme を加算せず上書きする", () => {
    const { vrm } = mockBodyVrm();
    const manager = vrm.expressionManager;
    if (!manager) throw new Error("expression manager is required");
    const setValue = vi.spyOn(manager, "setValue");
    const body = new Body(vrm, undefined, mockClaimState());
    body.acquireExpressionSlot("persona", "lip", "aa", 0.2);
    body.setLipSyncSource({
      isMouthActive: () => true,
      sampleMouth: () => ({ aa: 0.7, ih: 0, ou: 0, ee: 0, oh: 0 }),
    });

    body.update(1 / 60, 0);

    const aaWrites = setValue.mock.calls.filter(([name]) => name === "aa");
    expect(aaWrites).toHaveLength(1);
    expect(aaWrites[0]?.[1]).toBeCloseTo(0.7);
  });
});

describe("Body motion activation ownership", () => {
  type Playback = Awaited<ReturnType<AnimationPlayer["play"]>>;

  function mockPendingPlay(body: Body) {
    const player = (body as unknown as { animationPlayer: AnimationPlayer }).animationPlayer;
    return vi.spyOn(player, "play");
  }

  function playback() {
    const completion = deferred<void>();
    const cancel = vi.fn(() => completion.resolve());
    const stop = vi.fn(async () => completion.resolve());
    return {
      result: {
        id: 1,
        completion: completion.promise,
        setWeight: vi.fn(),
        stop,
        cancel,
      } satisfies Playback,
      cancel,
    };
  }

  it("cancels playback that finishes loading after its scheduler handle is released", async () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    const loading = deferred<Playback>();
    mockPendingPlay(body).mockReturnValue(loading.promise);
    const latePlayback = playback();

    const handle = body.acquireMotionSlot({
      source: "system",
      priority: "speech-expression",
      animation: "anim:VRMA_head_tilt_down",
    });
    handle.cancel();
    loading.resolve(latePlayback.result);
    await flushMicrotasks();

    expect(latePlayback.cancel).toHaveBeenCalledOnce();
    await expect(handle.completion).resolves.toEqual({ reason: "cancelled" });
  });

  it("cancels a late lower-priority load without touching its active replacement", async () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    const speechLoading = deferred<Playback>();
    const personaLoading = deferred<Playback>();
    mockPendingPlay(body)
      .mockReturnValueOnce(speechLoading.promise)
      .mockReturnValueOnce(personaLoading.promise);
    const speechPlayback = playback();
    const personaPlayback = playback();

    const speech = body.acquireMotionSlot({
      source: "system",
      priority: "speech-expression",
      animation: "anim:VRMA_head_tilt_down",
    });
    const persona = body.acquireMotionSlot({
      source: "persona",
      priority: "persona-handler",
      animation: "anim:VRMA_wave",
    });
    personaLoading.resolve(personaPlayback.result);
    await flushMicrotasks();
    speechLoading.resolve(speechPlayback.result);
    await flushMicrotasks();

    expect(speechPlayback.cancel).toHaveBeenCalledOnce();
    expect(personaPlayback.cancel).not.toHaveBeenCalled();
    expect(persona.isActive()).toBe(true);
    await expect(speech.completion).resolves.toEqual({ reason: "preempted" });

    persona.cancel();
    expect(personaPlayback.cancel).toHaveBeenCalledOnce();
  });

  it("cancels a pending scheduler slot before a late load resolves after disposal", async () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    const loading = deferred<Playback>();
    mockPendingPlay(body).mockReturnValue(loading.promise);
    const latePlayback = playback();
    const handle = body.acquireMotionSlot({
      source: "system",
      priority: "speech-expression",
      animation: "anim:VRMA_small_nod",
    });

    body.dispose();
    loading.resolve(latePlayback.result);
    await flushMicrotasks();

    expect(body.getMotionSnapshot().active).toBeNull();
    expect(latePlayback.cancel).toHaveBeenCalledOnce();
    await expect(handle.completion).resolves.toEqual({ reason: "cancelled" });
  });

  it("cancels an active scheduler slot before stopping all playback during disposal", async () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    const activePlayback = playback();
    const player = (body as unknown as { animationPlayer: AnimationPlayer }).animationPlayer;
    vi.spyOn(player, "play").mockResolvedValue(activePlayback.result);
    const order: string[] = [];
    activePlayback.cancel.mockImplementation(() => order.push("slot-cancel"));
    vi.spyOn(player, "stopAll").mockImplementation(() => order.push("stop-all"));
    const handle = body.acquireMotionSlot({
      source: "system",
      priority: "speech-expression",
      animation: "anim:VRMA_small_nod",
    });
    await flushMicrotasks();

    body.dispose();

    expect(order).toEqual(["slot-cancel", "stop-all"]);
    expect(body.getMotionSnapshot().active).toBeNull();
    await expect(handle.completion).resolves.toEqual({ reason: "cancelled" });
  });

  it("dispose releases expression owners, invalidates retained handles, clears slots, and zeros sink", () => {
    const { vrm } = mockBodyVrm();
    const manager = vrm.expressionManager;
    if (!manager) throw new Error("expression manager is required");
    vi.spyOn(manager, "getExpression").mockImplementation((name) =>
      name === "Fcl_BRW_Joy" ? ({} as never) : null,
    );
    const setValue = vi.spyOn(manager, "setValue");
    const body = new Body(vrm, undefined, mockClaimState());
    const retained = body.acquireExpressionSlot("persona", "custom", "Fcl_BRW_Joy", 0.6);
    const explicitBlink = body.acquireExpressionSlot("reflex", "eye", "blink", 0.8);
    body.update(1 / 60, 0);
    expect(setValue).toHaveBeenCalledWith("Fcl_BRW_Joy", expect.any(Number));

    setValue.mockClear();
    body.dispose();

    expect(body.getExpressionSlots()).toEqual([]);
    expect(body.getExpressionIntentSnapshot().intents).toEqual([]);
    expect((body as unknown as { blinkSystem: BlinkSystem }).blinkSystem.isSuppressed).toBe(false);
    expect(setValue).toHaveBeenCalledWith("Fcl_BRW_Joy", 0);

    retained.setIntensity(1);
    retained.release();
    explicitBlink.release();
    expect(body.getExpressionSlots()).toEqual([]);
  });

  it("blends procedural motion beneath an active speech-expression VRMA", async () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    const activePlayback = playback();
    const player = (body as unknown as { animationPlayer: AnimationPlayer }).animationPlayer;
    vi.spyOn(player, "play").mockResolvedValue(activePlayback.result);
    vi.spyOn(player, "getTotalEffectiveWeight").mockReturnValue(0.32);
    const proceduralBones = (
      body as unknown as {
        proceduralBones: { update(delta: number, elapsed: number, weight: number): void };
      }
    ).proceduralBones;
    const updateProcedural = vi.spyOn(proceduralBones, "update");

    const speech = body.acquireMotionSlot({
      source: "system",
      priority: "speech-expression",
      animation: "anim:VRMA_small_nod",
      options: { weight: 0.32 },
    });
    await flushMicrotasks();
    body.update(1 / 60, 0);

    expect(updateProcedural).toHaveBeenCalledOnce();
    expect(updateProcedural.mock.calls[0][0]).toBe(1 / 60);
    expect(updateProcedural.mock.calls[0][1]).toBe(0);
    expect(updateProcedural.mock.calls[0][2]).toBeCloseTo(0.68);
    speech.cancel();
  });

  it("animation claim 中は procedural head pose を外し、release 後に neutral idleへ戻す", () => {
    const { vrm, getBone } = mockBodyVrm();
    const claimState = mockClaimState();
    const body = new Body(vrm, undefined, claimState);

    body.update(1 / 60, 0);
    expect(getBone("head").rotation.x).toBeLessThan(0);

    const claim = claimState.claim("animation");
    body.update(1 / 60, 1 / 60);
    expect(getBone("head").rotation.x).toBeCloseTo(0, 6);

    claim.dispose();
    body.update(1 / 60, 2 / 60);
    expect(getBone("head").rotation.x).toBeLessThan(0);
  });
});

// ─── Body speech microexpression wiring ─────────────────

describe("Body speech microexpression wiring", () => {
  function speechSource(volume: number) {
    return {
      isMouthActive: () => true,
      sampleMouth: vi.fn(() => ({ aa: volume, ih: 0, ou: 0, ee: 0, oh: 0 })),
    };
  }

  function exposeExpressions(vrm: VRM, names: ReadonlySet<string>) {
    const manager = vrm.expressionManager;
    if (!manager) throw new Error("expression manager is required");
    vi.spyOn(manager, "getExpression").mockImplementation((name) =>
      names.has(name) ? ({} as never) : null,
    );
    return vi.spyOn(manager, "setValue");
  }

  it("取得済み mouth 信号を眉・目のgrounded intentとして出力する", () => {
    const { vrm } = mockBodyVrm();
    const setValue = exposeExpressions(vrm, new Set(["Fcl_BRW_Surprised", "Fcl_EYE_Spread"]));
    const body = new Body(vrm, undefined, mockClaimState());
    body.setState("thinking");
    body.setSpeechExpressionParams({ flickEnabled: false, attackMs: 100 });
    const source = speechSource(0.8);
    body.setLipSyncSource(source);

    body.update(0.05, 0);

    expect(source.sampleMouth).toHaveBeenCalledOnce();
    expect(setValue).toHaveBeenCalledWith("Fcl_BRW_Surprised", expect.any(Number));
    expect(setValue).toHaveBeenCalledWith("Fcl_EYE_Spread", expect.any(Number));
    const browWrite = setValue.mock.calls.find(([name]) => name === "Fcl_BRW_Surprised");
    expect(browWrite?.[1]).toBeGreaterThan(0);
    const snapshot = body.getExpressionIntentSnapshot();
    expect(snapshot.intents.find((i) => i.owner.producerId === "speech-brow")?.phase).toMatch(
      /^(active|blended)$/,
    );
    expect(snapshot.intents.find((i) => i.owner.producerId === "speech-eye")?.phase).toMatch(
      /^(active|blended)$/,
    );
  });

  it("explicit personaが眉領域を所有するとspeech browをreason付きでsuppressする", () => {
    const { vrm } = mockBodyVrm();
    exposeExpressions(vrm, new Set(["Fcl_BRW_Surprised", "Fcl_EYE_Spread"]));
    const body = new Body(vrm, undefined, mockClaimState());
    body.setSpeechExpressionParams({ flickEnabled: false, attackMs: 100 });
    body.setLipSyncSource(speechSource(0.8));
    body.update(0.05, 0);

    const persona = body.acquireExpressionSlot("persona", "part-brow", "Fcl_BRW_Surprised", 0.3);
    const snapshot = body.getExpressionIntentSnapshot();
    const speech = snapshot.intents.find((i) => i.owner.producerId === "speech-brow");
    const owner = snapshot.intents.find((i) => i.owner.producerId === "legacy-persona");
    expect(speech).toMatchObject({ phase: "suppressed", reason: "lower-priority-overlap" });
    expect(speech?.suppressedBy).toBe(owner?.intentId);
    expect(
      body
        .getExpressionSlots()
        .find((s) => s.source === "speech" && s.expressionName === "Fcl_BRW_Surprised")
        ?.effectiveWeight,
    ).toBe(0);
    persona.release();
  });

  it("expression claim 中は発話反射を更新・適用しない", () => {
    const { vrm } = mockBodyVrm();
    const setValue = exposeExpressions(vrm, new Set(["Fcl_BRW_Surprised", "Fcl_EYE_Spread"]));
    const claimState = mockClaimState();
    const body = new Body(vrm, undefined, claimState);
    body.setLipSyncSource(speechSource(0.8));
    const claim = claimState.claim("expression");

    body.update(0.1, 0);

    expect(setValue).not.toHaveBeenCalled();
    claim.dispose();
  });

  it("対象 morph が無い VRM では発話反射だけを no-op にする", () => {
    const { vrm } = mockBodyVrm();
    const setValue = exposeExpressions(vrm, new Set());
    const body = new Body(vrm, undefined, mockClaimState());
    body.setLipSyncSource(speechSource(0.8));

    body.update(0.1, 0);

    expect(setValue).not.toHaveBeenCalledWith("Fcl_BRW_Surprised", expect.any(Number));
    expect(setValue).not.toHaveBeenCalledWith("Fcl_EYE_Spread", expect.any(Number));
    expect(setValue).toHaveBeenCalledWith("aa", 0.8);
  });

  it("発話 engagement 中もidle micro timerを維持しArbiterでsuppressする", () => {
    const { vrm } = mockBodyVrm();
    exposeExpressions(vrm, new Set([...MICRO_BROW_POOL, ...MICRO_EYE_POOL, ...MICRO_MOUTH_POOL]));
    const body = new Body(vrm, undefined, mockClaimState());
    const channels = (
      body as unknown as {
        microChannels: ReadonlyArray<{
          region: "brow" | "eye" | "mouth";
          system: IdleMicroexpressionSystem;
        }>;
      }
    ).microChannels;
    const brow = channels.find((channel) => channel.region === "brow");
    const eye = channels.find((channel) => channel.region === "eye");
    brow?.system.injectEpisode("Fcl_BRW_Joy", 0.2, 0.4);
    eye?.system.injectEpisode("Fcl_EYE_Sorrow", 0.2, 0.4);
    body.setSpeechExpressionParams({ flickEnabled: false });
    body.setLipSyncSource(speechSource(0.8));

    body.update(0.05, 0);

    expect(brow?.system.value).not.toBeNull();
    expect(eye?.system.value).not.toBeNull();
    const snapshot = body.getExpressionIntentSnapshot();
    for (const producerId of ["idle-micro-brow", "idle-micro-eye"]) {
      expect(snapshot.intents.find((i) => i.owner.producerId === producerId)).toMatchObject({
        phase: "suppressed",
        reason: "ambient-suspended-by-grounded",
      });
    }
  });

  it("フレーズ境界blinkをeyelid/physiology intentとして発行する", () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    const source = speechSource(0.8);
    body.setLipSyncSource(source);
    body.setSpeechExpressionParams({ gapThresholdMs: 100, blinkProbability: 1 });
    body.update(0.1, 0);
    source.sampleMouth.mockReturnValue({ aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 });

    body.update(0.11, 0.11);

    const boundary = body
      .getExpressionIntentSnapshot()
      .intents.find((i) => i.owner.producerId === "speech-boundary-blink");
    expect(boundary?.occupancy).toEqual([{ region: "eyelid", lane: "physiology" }]);
    expect(boundary?.semantic.role).toBe("baseline");
    expect(boundary?.phase).toMatch(/^(active|blended)$/);
    expect((body as unknown as { blinkSystem: BlinkSystem }).blinkSystem.isSuppressed).toBe(true);

    body.update(0.14, 0.25);
    expect((body as unknown as { blinkSystem: BlinkSystem }).blinkSystem.isSuppressed).toBe(true);
    body.update(0.09, 0.34);
    expect((body as unknown as { blinkSystem: BlinkSystem }).blinkSystem.isSuppressed).toBe(false);
  });

  it("speech-boundary blinkは明示blinkへ譲り、startle safety-reflexだけが最優先になる", () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    const explicit = body.acquireExpressionSlot("persona", "eye", "blink", 0.8);
    const source = speechSource(0.8);
    body.setLipSyncSource(source);
    body.setSpeechExpressionParams({ gapThresholdMs: 100, blinkProbability: 1 });
    body.update(0.1, 0);
    source.sampleMouth.mockReturnValue({ aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 });

    body.update(0.11, 0.11);

    let snapshot = body.getExpressionIntentSnapshot();
    const explicitEntry = snapshot.intents.find((i) => i.owner.producerId === "legacy-persona");
    expect(explicitEntry?.phase).toBe("active");
    expect(
      snapshot.intents.find((i) => i.owner.producerId === "speech-boundary-blink"),
    ).toMatchObject({
      semantic: { role: "baseline" },
      phase: "suppressed",
      suppressedBy: explicitEntry?.intentId,
    });

    body.notifyStartle();
    snapshot = body.getExpressionIntentSnapshot();
    const startle = snapshot.intents.find((i) => i.owner.producerId === "startle-blink");
    expect(startle?.phase).toBe("active");
    expect(snapshot.intents.find((i) => i.owner.producerId === "legacy-persona")).toMatchObject({
      phase: "suppressed",
      suppressedBy: startle?.intentId,
    });

    explicit.release();
  });
});

describe("Body speech mood wiring", () => {
  function speechMood(body: Body) {
    return body
      .getExpressionSlots()
      .find((slot) => slot.source === "speech" && slot.kind === "mood");
  }

  function speechBrowWeight(body: Body): number {
    return (
      body as unknown as {
        speechMicroexpression: { currentParams: { engagementBrowWeight: number } };
      }
    ).speechMicroexpression.currentParams.engagementBrowWeight;
  }

  it("restores the previous speech state layer when the newer owner releases", () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    const first = body.acquireSpeechStateExpression({
      preset: "happy",
      intensity: 0.3,
      microexpressionParams: { engagementBrowWeight: 0.02 },
    });
    const second = body.acquireSpeechStateExpression({
      preset: "sad",
      intensity: 0.4,
      microexpressionParams: { engagementBrowWeight: 0.03 },
    });

    expect(speechMood(body)?.expressionName).toBe("sad");
    expect(speechBrowWeight(body)).toBe(0.03);

    second.release();

    expect(speechMood(body)?.expressionName).toBe("happy");
    expect(speechBrowWeight(body)).toBe(0.02);
    first.release();
    expect(speechMood(body)).toBeUndefined();
    expect(speechBrowWeight(body)).toBe(0.06);
  });

  it("does not let an older speech state owner release the newer layer", () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    const first = body.acquireSpeechStateExpression({
      preset: "happy",
      microexpressionParams: { engagementBrowWeight: 0.02 },
    });
    const second = body.acquireSpeechStateExpression({
      preset: "surprised",
      microexpressionParams: { engagementBrowWeight: 0.04 },
    });

    first.release();

    expect(speechMood(body)?.expressionName).toBe("surprised");
    expect(speechBrowWeight(body)).toBe(0.04);
    second.release();
  });

  it("keeps a newer voice.say layer when an older grounded state releases", () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    const groundedState = body.acquireSpeechStateExpression({ preset: "happy", intensity: 0.3 });
    const voiceSayMood = body.acquireSpeechStateExpression({ preset: "surprised", intensity: 0.6 });

    groundedState.release();

    expect(speechMood(body)?.expressionName).toBe("surprised");
    voiceSayMood.release();
  });

  it("restores the debug speech profile after a grounded state layer releases", () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    body.setSpeechExpressionParams({ engagementBrowWeight: 0.09 });
    const groundedState = body.acquireSpeechStateExpression({
      microexpressionParams: { engagementBrowWeight: 0.02 },
    });

    expect(speechBrowWeight(body)).toBe(0.02);
    groundedState.release();

    expect(speechBrowWeight(body)).toBe(0.09);
  });

  it("ramps the speech mood and yields to persona and MCP mood ownership", () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());

    body.setSpeechMood("happy", 0.8);
    expect(speechMood(body)).toMatchObject({
      source: "speech",
      kind: "mood",
      expressionName: "happy",
      requestedWeight: 0,
    });

    body.update(0.3, 0);
    expect(speechMood(body)?.requestedWeight).toBeCloseTo(0.8);

    const persona = body.acquireExpressionSlot("persona", "mood", "sad", 0.4);
    expect(speechMood(body)?.effectiveWeight).toBe(0);
    expect(persona.effectiveWeight).toBeCloseTo(0.4);

    const mcp = body.acquireExpressionSlot("mcp", "mood", "surprised", 0.3);
    expect(persona.effectiveWeight).toBe(0);
    expect(mcp.effectiveWeight).toBeCloseTo(0.3);
  });

  it("release 時間で weight を 0 にしてから slot を解放する", () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    body.setSpeechMood("relaxed", 0.8);
    body.update(0.3, 0);

    body.releaseSpeechMood();
    body.update(0.25, 0.25);
    expect(speechMood(body)?.requestedWeight).toBeCloseTo(0.4);

    body.update(0.25, 0.5);
    expect(speechMood(body)).toBeUndefined();
  });

  it("新しい speech mood で前の slot を上書きする", () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    body.setSpeechMood("happy", 0.8);
    body.update(0.1, 0);

    body.setSpeechMood("surprised", 0.6);

    const slots = body
      .getExpressionSlots()
      .filter((slot) => slot.source === "speech" && slot.kind === "mood");
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ expressionName: "surprised", requestedWeight: 0 });
  });

  it("keeps idle micro episode alive while speech mood suppresses it", () => {
    const { vrm } = mockBodyVrm();
    const manager = vrm.expressionManager;
    if (!manager) throw new Error("expression manager is required");
    vi.spyOn(manager, "getExpression").mockImplementation((name) =>
      name === "Fcl_BRW_Joy" ? ({} as never) : null,
    );
    const body = new Body(vrm, undefined, mockClaimState());
    const channels = (
      body as unknown as {
        microChannels: ReadonlyArray<{
          region: "brow" | "eye" | "mouth";
          system: IdleMicroexpressionSystem;
        }>;
      }
    ).microChannels;
    const brow = channels.find((channel) => channel.region === "brow");
    brow?.system.injectEpisode("Fcl_BRW_Joy", 0.2, 0.4);
    body.update(0.05, 0);
    expect(brow?.system.value).not.toBeNull();

    body.setSpeechMood("happy", 0.3);
    body.update(0.3, 0.3);

    expect(speechMood(body)?.effectiveWeight).toBeGreaterThan(0);
    expect(brow?.system.value).not.toBeNull();
    const micro = body
      .getExpressionIntentSnapshot()
      .intents.find((i) => i.owner.producerId === "idle-micro-brow");
    expect(micro).toMatchObject({
      phase: "suppressed",
      reason: "ambient-suspended-by-grounded",
    });
  });

  it("speech mood intent は ambient を reason 付きで suppress し、release で復帰する（#83 M4）", () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    const arbiter = (body as unknown as { expressionIntents: ExpressionIntentArbiter })
      .expressionIntents;
    body.update(1 / 60, 0);

    body.setSpeechMood("happy", 0.6);
    body.update(0.3, 0.3);

    const snapshot = arbiter.getSnapshot();
    const mood = snapshot.intents.find((i) => i.owner.producerId === "speech-mood");
    const stateBase = snapshot.intents.find((i) => i.owner.producerId === "state-base");
    expect(mood?.phase).toBe("active");
    expect(stateBase?.phase).toBe("suppressed");
    expect(stateBase?.reason).toBe("ambient-suspended-by-grounded");
    expect(stateBase?.suppressedBy).toBe(mood?.intentId);

    // release は speech mood owner だけを閉じ、ambient が復帰する
    // （blended になるかは同時に走る micro episode の乱数次第なので admitted 系
    //   phase であることだけを見る）
    body.releaseSpeechMood();
    for (let t = 0; t < 1; t += 0.1) body.update(0.1, 0.3 + t);
    expect(
      arbiter.getSnapshot().intents.find((i) => i.owner.producerId === "state-base")?.phase,
    ).toMatch(/^(active|blended)$/);
    expect(body.getExpressionSlots().some((s) => s.source === "speech" && s.kind === "mood")).toBe(
      false,
    );
  });

  it("persona expression は speech mood を suppress し、reason が snapshot に残る（#83 M5）", () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    body.setSpeechMood("happy", 0.6);
    body.update(0.3, 0);

    const persona = body.acquireExpressionSlot("persona", "mood", "sad", 0.4);

    const snapshot = body.getExpressionIntentSnapshot();
    const mood = snapshot.intents.find((i) => i.owner.producerId === "speech-mood");
    const personaIntent = snapshot.intents.find((i) => i.owner.producerId === "legacy-persona");
    expect(mood?.phase).toBe("suppressed");
    expect(mood?.reason).toBe("lower-priority-overlap");
    expect(mood?.suppressedBy).toBe(personaIntent?.intentId);
    // slot view 互換: suppress された speech mood slot は effective 0 で残る
    const slot = body.getExpressionSlots().find((s) => s.source === "speech" && s.kind === "mood");
    expect(slot?.effectiveWeight).toBe(0);

    persona.release();
    expect(
      body.getExpressionIntentSnapshot().intents.find((i) => i.owner.producerId === "speech-mood")
        ?.phase,
    ).toBe("active");
  });

  it("coexists with reflex blink and lip sync without taking either channel", () => {
    const { vrm } = mockBodyVrm();
    const manager = vrm.expressionManager;
    if (!manager) throw new Error("expression manager is required");
    const setValue = vi.spyOn(manager, "setValue");
    const body = new Body(vrm, undefined, mockClaimState());
    body.setLipSyncSource({
      isMouthActive: () => true,
      sampleMouth: () => ({ aa: 0.7, ih: 0, ou: 0, ee: 0, oh: 0 }),
    });
    body.setSpeechMood("happy", 0.3);
    body.acquireExpressionSlot("reflex", "eye", "blink", 0.6);

    body.update(0.3, 0);

    expect(setValue).toHaveBeenCalledWith("happy", 0.3);
    expect(setValue).toHaveBeenCalledWith("blink", 0.6);
    expect(setValue).toHaveBeenCalledWith("aa", 0.7);
  });

  it("Body経路でもmcpとsystemの同格moodを旧挙動どおりblendする", () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    body.acquireExpressionSlot("mcp", "mood", "sad", 0.3);
    body.acquireExpressionSlot("system", "mood", "neutral", 0.4);

    const slots = body
      .getExpressionSlots()
      .filter((slot) => slot.source === "mcp" || slot.source === "system");
    expect(slots).toHaveLength(2);
    expect(slots.find((slot) => slot.source === "mcp")?.effectiveWeight).toBeCloseTo(0.3);
    expect(slots.find((slot) => slot.source === "system")?.effectiveWeight).toBeCloseTo(0.4);
    const intents = body
      .getExpressionIntentSnapshot()
      .intents.filter((intent) => intent.source === "mcp" || intent.source === "system");
    expect(intents.map((intent) => intent.phase)).toEqual(["blended", "blended"]);
  });
});

// ─── Body explicit blink wiring ──────────────────────────
//
// #83 M5 で explicit blink の ownership は BlinkSystem の suppression token
// から arbiter の physiology precedence（explicit-action > baseline reflex）
// へ移った。出力パリティ（explicit 中は自律瞬きが混ざらない・release で
// 再開する）を固定する。reflex source の直接 acquire だけは同 precedence の
// ため token を維持する（下のテスト）。

describe("Body explicit blink wiring", () => {
  it.each([
    { phase: "closing", steps: [2.49, 0.02] },
    { phase: "opening", steps: [2.49, 0.05, 0.02] },
  ])("$phase途中でexplicit blinkを取得・releaseしてもordinary blinkの途中値を露出しない", ({
    steps,
  }) => {
    const { vrm } = mockBodyVrm();
    const manager = vrm.expressionManager;
    if (!manager) throw new Error("expression manager is required");
    const setValue = vi.spyOn(manager, "setValue");
    const body = new Body(vrm, undefined, mockClaimState());
    const deterministicBlink = new BlinkSystem(() => 0);
    (body as unknown as { blinkSystem: BlinkSystem }).blinkSystem = deterministicBlink;
    let elapsed = 0;
    for (const step of steps) {
      elapsed += step;
      body.update(step, elapsed);
    }
    expect(deterministicBlink.value).toBeGreaterThan(0);

    const handle = body.acquireExpressionSlot("persona", "eye", "blink", 0.8);
    expect(deterministicBlink.value).toBe(0);
    elapsed += 0.01;
    body.update(0.01, elapsed);
    setValue.mockClear();
    handle.release();
    body.update(0.01, elapsed + 0.01);

    const immediateBlinkWrites = setValue.mock.calls.filter(
      ([name, weight]) => name === "blink" && (weight as number) > 0,
    );
    expect(immediateBlinkWrites).toEqual([]);
  });

  it("explicit blink 中は自律瞬きが出力に混ざらず、release 後に再開する", () => {
    const { vrm } = mockBodyVrm();
    const manager = vrm.expressionManager;
    if (!manager) throw new Error("expression manager is required");
    const setValue = vi.spyOn(manager, "setValue");
    const body = new Body(vrm, undefined, mockClaimState());

    const handle = body.acquireExpressionSlot("mcp", "eye", "blink", 0.8);
    // 自律瞬き間隔（最大 ~4.5s）を跨いで回しても、blink への write は
    // explicit slot の budget 済み一定値のみ（自律瞬きの変動が混ざらない）
    for (let t = 0; t < 6; t += 0.05) body.update(0.05, t);
    const during = setValue.mock.calls.filter(([name]) => name === "blink");
    expect(during.length).toBeGreaterThan(0);
    const uniqueWeights = new Set(during.map(([, w]) => (w as number).toFixed(6)));
    expect(uniqueWeights.size).toBe(1);

    // arbiter は auto blink の suppression を reason 付きで説明できる
    const arbiter = (body as unknown as { expressionIntents: ExpressionIntentArbiter })
      .expressionIntents;
    const autoBlink = arbiter
      .getSnapshot()
      .intents.find((i) => i.owner.producerId === "auto-blink");
    if (autoBlink) {
      expect(autoBlink.phase).toBe("suppressed");
      expect(autoBlink.reason).toBe("lower-priority-overlap");
    }

    // release 後は自律瞬きが再開する（explicit の一定値以外の write が現れる）
    setValue.mockClear();
    handle.release();
    const explicitWeight = [...uniqueWeights][0];
    for (let t = 6; t < 20; t += 0.05) body.update(0.05, t);
    const resumed = setValue.mock.calls.filter(
      ([name, w]) =>
        name === "blink" && (w as number) > 0 && (w as number).toFixed(6) !== explicitWeight,
    );
    expect(resumed.length).toBeGreaterThan(0);
  });

  it("reflex source の blink 直接 acquire は suppression token で自律瞬きを止める", () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    const blinkSystem = (body as unknown as { blinkSystem: BlinkSystem }).blinkSystem;
    expect(blinkSystem.isSuppressed).toBe(false);

    const handle = body.acquireExpressionSlot("reflex", "eye", "blink", 0.8);
    expect(blinkSystem.isSuppressed).toBe(true);

    handle.release();
    expect(blinkSystem.isSuppressed).toBe(false);
  });

  it("blink 以外の eye slot は自律瞬きを suppress しない", () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    const blinkSystem = (body as unknown as { blinkSystem: BlinkSystem }).blinkSystem;

    const handle = body.acquireExpressionSlot("mcp", "eye", "lookUp", 0.5);
    expect(blinkSystem.isSuppressed).toBe(false);
    handle.release();
  });

  it("startle blinkはexplicit blinkを上書きする独立safety-reflex pulseになる", () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    const explicit = body.acquireExpressionSlot("persona", "eye", "blink", 0.8);

    body.notifyStartle();
    body.update(0.025, 0);

    const snapshot = body.getExpressionIntentSnapshot();
    expect(snapshot.intents.find((i) => i.owner.producerId === "startle-blink")).toMatchObject({
      semantic: { role: "safety-reflex", target: "blink" },
      phase: "active",
    });
    expect(snapshot.intents.find((i) => i.owner.producerId === "legacy-persona")).toMatchObject({
      phase: "suppressed",
      reason: "lower-priority-overlap",
    });
    explicit.release();
  });
});

// ─── Body idle relaxed wiring ────────────────────────────
//
// relaxed は state base (idle/mood) との (source, kind) 衝突を避けて
// idle/custom で併存する現挙動の characterization（#83 M0、M3 の移行対象）。

describe("Body idle relaxed wiring", () => {
  function idleSlots(body: Body) {
    return body.getExpressionSlots().filter((slot) => slot.source === "idle");
  }

  it("30 秒 idle 後、relaxed (custom) は state base (mood) と併存する", () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    for (let t = 0; t < 45; t += 0.5) body.update(0.5, t);

    const slots = idleSlots(body);
    const neutral = slots.find((s) => s.kind === "mood" && s.expressionName === "neutral");
    const relaxed = slots.find((s) => s.kind === "custom" && s.expressionName === "relaxed");
    expect(neutral).toBeDefined();
    expect(relaxed).toBeDefined();
    expect(relaxed?.requestedWeight).toBeGreaterThan(0);
  });

  it("idle neutralとrelaxedは旧配分 neutral=1-relaxed を維持する", () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    const blinkSystem = (body as unknown as { blinkSystem: BlinkSystem }).blinkSystem;
    const suppressionToken = blinkSystem.suppress();

    // 1 frameでrelaxed上限まで進める。squintはepisode開始frameではまだ0。
    // 長いdeltaでordinary blinkが同時発火してglobal budgetへ混ざらないよう、
    // この配分テスト中だけblink state machineを停止する。
    body.update(34, 0);

    const slots = idleSlots(body);
    const neutral = slots.find((s) => s.kind === "mood" && s.expressionName === "neutral");
    const relaxed = slots.find((s) => s.kind === "custom" && s.expressionName === "relaxed");
    expect(neutral?.requestedWeight).toBeCloseTo(0.6);
    expect(relaxed?.requestedWeight).toBeCloseTo(0.4);
    expect(neutral?.effectiveWeight).toBeCloseTo(0.6);
    expect(relaxed?.effectiveWeight).toBeCloseTo(0.4);
    blinkSystem.resume(suppressionToken);
  });

  it("non-idle mood中もrelaxed timer/intentを維持しrelease直後に復帰する", () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    for (let t = 0; t < 45; t += 0.5) body.update(0.5, t);
    expect(idleSlots(body).some((s) => s.expressionName === "relaxed")).toBe(true);

    const persona = body.acquireExpressionSlot("persona", "mood", "happy", 0.5);
    body.update(0.1, 45.1);

    const slots = idleSlots(body);
    const relaxed = slots.find((s) => s.expressionName === "relaxed");
    expect(relaxed?.requestedWeight).toBe(0);
    expect(relaxed?.effectiveWeight).toBe(0);
    expect(slots.some((s) => s.kind === "mood" && s.expressionName === "neutral")).toBe(true);
    expect(
      body.getExpressionIntentSnapshot().intents.find((i) => i.owner.producerId === "idle-relaxed"),
    ).toMatchObject({ phase: "suppressed", reason: "ambient-suspended-by-grounded" });

    persona.release();
    body.update(0.01, 45.11);
    expect(
      idleSlots(body).find((s) => s.expressionName === "relaxed")?.requestedWeight,
    ).toBeGreaterThan(0);
  });
});

// ─── Body expression claim wiring ────────────────────────
//
// ClaimState.expression が Body の frame orchestration を bypass する
// 現挙動の characterization（#83 M0）。arbiter 移行後は `domain-claimed`
// reason として観察可能になる予定の seam。

describe("Body expression claim wiring", () => {
  it("claim 中の setState は state base 表情を書き換えず、release 後の update で追従する", () => {
    const { vrm } = mockBodyVrm();
    const claimState = mockClaimState();
    const body = new Body(vrm, undefined, claimState);
    const claim = claimState.claim("expression");

    body.setState("thinking");
    const during = body.getExpressionSlots().find((s) => s.source === "idle" && s.kind === "mood");
    // idle 時の neutral 1.0 のまま（thinking の 0.4 に切り替わらない）
    expect(during?.requestedWeight).toBe(1);

    claim.dispose();
    body.update(1 / 60, 0);

    const after = body.getExpressionSlots().find((s) => s.source === "idle" && s.kind === "mood");
    expect(after?.requestedWeight).toBeCloseTo(0.4);
  });
});

// ─── Body ambient intent cutover（#83 M3）────────────────
//
// ambient producer（state base / relaxed / squint / micro）は intent →
// arbiter → slot bridge の経路で ExpressionManager keyed slot になる。
// 併存の見た目（M0 characterization）は上の describe が固定しているので、
// ここでは intent 経路固有の観察（keyed slot / reason 付き snapshot /
// claim 中の凍結）を固定する。

describe("Body ambient intent cutover", () => {
  function arbiterOf(body: Body) {
    return (body as unknown as { expressionIntents: ExpressionIntentArbiter }).expressionIntents;
  }

  it("idle neutral + relaxed は keyed slot として併存し、blended として観察できる", () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    for (let t = 0; t < 45; t += 0.5) body.update(0.5, t);

    const slots = body.getExpressionSlots();
    const neutral = slots.find((s) => s.source === "idle" && s.kind === "mood");
    const relaxed = slots.find((s) => s.kind === "custom" && s.expressionName === "relaxed");
    expect(neutral?.key).toBeDefined();
    expect(relaxed?.key).toBeDefined();

    const snapshot = arbiterOf(body).getSnapshot();
    const stateBase = snapshot.intents.find((i) => i.owner.producerId === "state-base");
    const relaxedIntent = snapshot.intents.find((i) => i.owner.producerId === "idle-relaxed");
    // neutral (full-face) と relaxed (eye) は eye/affect で重なり blend する
    expect(stateBase?.phase).toBe("blended");
    expect(relaxedIntent?.phase).toBe("blended");
  });

  it("expression claim 中は intent が domain-claimed になり、slot は凍結される", () => {
    const { vrm } = mockBodyVrm();
    const claimState = mockClaimState();
    const body = new Body(vrm, undefined, claimState);
    body.update(1 / 60, 0);
    const before = body
      .getExpressionSlots()
      .filter((s) => s.source === "idle" && s.kind === "mood");
    expect(before).toHaveLength(1);

    const claim = claimState.claim("expression");
    body.update(1 / 60, 0.1);
    body.update(1 / 60, 0.2);

    // claim は apply 層で止まるだけで slot は据え置き（legacy の claim 挙動と互換）
    const during = body
      .getExpressionSlots()
      .filter((s) => s.source === "idle" && s.kind === "mood");
    expect(during).toHaveLength(1);
    // arbiter 側は理由付きで suppress を説明する
    const stateBase = arbiterOf(body)
      .getSnapshot()
      .intents.find((i) => i.owner.producerId === "state-base");
    expect(stateBase?.phase).toBe("suppressed");
    expect(stateBase?.reason).toBe("domain-claimed");

    claim.dispose();
    body.update(1 / 60, 0.3);
    expect(
      arbiterOf(body)
        .getSnapshot()
        .intents.find((i) => i.owner.producerId === "state-base")?.phase,
    ).toBe("active");
  });
});

// ─── ExpressionManager ───────────────────────────────────

describe("ExpressionManager", () => {
  it("single expression: effective equals requested", () => {
    const mgr = new ExpressionManager();
    const id = mgr.addSlot("persona", "mood", "happy", 0.5);
    expect(mgr.getEffectiveWeight(id)).toBe(0.5);
  });

  it("two expressions under budget: no scale-down", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("persona", "mood", "happy", 0.3);
    const b = mgr.addSlot("reflex", "eye", "sad", 0.4);
    expect(mgr.getEffectiveWeight(a)).toBe(0.3);
    expect(mgr.getEffectiveWeight(b)).toBe(0.4);
  });

  it("two expressions at exactly 1.0: no scale-down", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("persona", "mood", "happy", 0.6);
    const b = mgr.addSlot("reflex", "eye", "sad", 0.4);
    expect(mgr.getEffectiveWeight(a)).toBe(0.6);
    expect(mgr.getEffectiveWeight(b)).toBe(0.4);
  });

  it("two expressions over budget: proportional scale-down", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("persona", "mood", "happy", 0.8);
    const b = mgr.addSlot("reflex", "eye", "sad", 0.4);
    // total = 1.2, scale = 1/1.2
    expect(mgr.getEffectiveWeight(a)).toBeCloseTo(0.8 / 1.2);
    expect(mgr.getEffectiveWeight(b)).toBeCloseTo(0.4 / 1.2);
    // Sum should be exactly 1
    expect(mgr.getEffectiveWeight(a) + mgr.getEffectiveWeight(b)).toBeCloseTo(1.0);
  });

  it("three expressions over budget: priority suppression + scale-down", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("persona", "mood", "happy", 0.5);
    const b = mgr.addSlot("mcp", "mood", "sad", 0.5);
    const c = mgr.addSlot("reflex", "eye", "surprised", 0.5);
    // mcp(3) > persona(2) in mood → persona suppressed
    // active: mcp/mood 0.5 + reflex/eye 0.5 = 1.0 → no scale-down
    expect(mgr.getEffectiveWeight(a)).toBe(0);
    expect(mgr.getEffectiveWeight(b)).toBe(0.5);
    expect(mgr.getEffectiveWeight(c)).toBe(0.5);
  });

  it("removing a slot gives remaining expressions more budget", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("persona", "mood", "happy", 0.8);
    const b = mgr.addSlot("reflex", "eye", "sad", 0.4);
    // Over budget: a = 0.8/1.2, b = 0.4/1.2
    expect(mgr.getEffectiveWeight(a)).toBeCloseTo(0.8 / 1.2);

    mgr.removeSlot(b);
    // Now only a at 0.8, under budget
    expect(mgr.getEffectiveWeight(a)).toBe(0.8);
    expect(mgr.getEffectiveWeight(b)).toBe(0); // removed
  });

  it("setWeight updates effective weights", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("persona", "mood", "happy", 0.3);
    expect(mgr.getEffectiveWeight(a)).toBe(0.3);

    mgr.setWeight(a, 0.7);
    expect(mgr.getEffectiveWeight(a)).toBe(0.7);
  });

  it("setWeight triggers budget recomputation", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("persona", "mood", "happy", 0.5);
    const b = mgr.addSlot("reflex", "eye", "sad", 0.3);
    // total 0.8 — under budget
    expect(mgr.getEffectiveWeight(a)).toBe(0.5);

    mgr.setWeight(a, 0.9);
    // total 1.2 — over budget now
    expect(mgr.getEffectiveWeight(a)).toBeCloseTo(0.9 / 1.2);
    expect(mgr.getEffectiveWeight(b)).toBeCloseTo(0.3 / 1.2);
  });

  it("getResolved: higher priority source suppresses lower in same kind", () => {
    const mgr = new ExpressionManager();
    mgr.addSlot("persona", "mood", "happy", 0.3);
    mgr.addSlot("mcp", "mood", "happy", 0.2);
    mgr.addSlot("reflex", "eye", "sad", 0.1);

    // mcp(3) > persona(2) in mood → persona suppressed
    const resolved = mgr.getResolved();
    expect(resolved.get("happy")).toBeCloseTo(0.2);
    expect(resolved.get("sad")).toBeCloseTo(0.1);
  });

  it("empty manager: getResolved returns empty map", () => {
    const mgr = new ExpressionManager();
    expect(mgr.getResolved().size).toBe(0);
  });

  it("zero weight slot does not cause division by zero", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("persona", "mood", "happy", 0);
    expect(mgr.getEffectiveWeight(a)).toBe(0);
    expect(mgr.size).toBe(1);
  });

  it("setWeight on nonexistent ID is a no-op", () => {
    const mgr = new ExpressionManager();
    mgr.setWeight(999, 0.5); // should not throw
    expect(mgr.size).toBe(0);
  });

  it("removeSlot on nonexistent ID is a no-op", () => {
    const mgr = new ExpressionManager();
    mgr.removeSlot(999); // should not throw
    expect(mgr.size).toBe(0);
  });

  // ─── source / kind dedup ─────────────────────────────────

  it("per-(source, kind) dedup: same source+kind releases previous slot", () => {
    const mgr = new ExpressionManager();
    const first = mgr.addSlot("mcp", "mood", "happy", 0.6);
    const second = mgr.addSlot("mcp", "mood", "sad", 0.4);

    // first slot は dedup により release されている
    expect(mgr.getEffectiveWeight(first)).toBe(0);
    expect(mgr.getEffectiveWeight(second)).toBe(0.4);
    expect(mgr.size).toBe(1);
  });

  it("different sources, same kind: higher priority wins", () => {
    const mgr = new ExpressionManager();
    mgr.addSlot("persona", "mood", "happy", 0.3);
    mgr.addSlot("mcp", "mood", "happy", 0.4);
    // mcp(3) > persona(2) → persona suppressed
    expect(mgr.size).toBe(2);
    expect(mgr.getResolved().get("happy")).toBeCloseTo(0.4);
  });

  it("4 slots of different (source, kind): priority suppression + scale-down", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("persona", "mood", "happy", 1);
    const b = mgr.addSlot("mcp", "mood", "sad", 1);
    const c = mgr.addSlot("reflex", "eye", "blink", 1);
    const d = mgr.addSlot("idle", "lip", "aa", 1);

    // mcp(3) > persona(2) in mood → persona suppressed
    // active: mcp/mood 1 + reflex/eye 1 + idle/lip 1 = 3 → scale 1/3
    expect(mgr.getEffectiveWeight(a)).toBe(0);
    expect(mgr.getEffectiveWeight(b)).toBeCloseTo(1 / 3);
    expect(mgr.getEffectiveWeight(c)).toBeCloseTo(1 / 3);
    expect(mgr.getEffectiveWeight(d)).toBeCloseTo(1 / 3);
  });

  it('source "reflex" suppresses "mcp" in same kind (reflex priority > mcp)', () => {
    const mgr = new ExpressionManager();
    mgr.addSlot("mcp", "mood", "happy", 0.3);
    mgr.addSlot("reflex", "mood", "happy", 0.2);
    // reflex(4) > mcp(3) in mood → mcp suppressed
    expect(mgr.getResolved().get("happy")).toBeCloseTo(0.2);
  });

  it("getSlots returns snapshots with source / kind / weights", () => {
    const mgr = new ExpressionManager();
    mgr.addSlot("mcp", "mood", "happy", 0.7);
    mgr.addSlot("reflex", "eye", "blink", 0.4);

    const snaps = mgr.getSlots();
    expect(snaps).toHaveLength(2);
    const happy = snaps.find((s) => s.expressionName === "happy");
    const blink = snaps.find((s) => s.expressionName === "blink");
    expect(happy).toMatchObject({
      source: "mcp",
      kind: "mood",
      expressionName: "happy",
      requestedWeight: 0.7,
    });
    expect(blink).toMatchObject({
      source: "reflex",
      kind: "eye",
      expressionName: "blink",
      requestedWeight: 0.4,
    });
    // total 1.1 → scaled-down
    expect(happy?.effectiveWeight).toBeCloseTo(0.7 / 1.1);
    expect(blink?.effectiveWeight).toBeCloseTo(0.4 / 1.1);
  });

  // ─── source priority golden tests（#83 M0 characterization）──
  //
  // arbiter 移行中の compatibility guard として、priority ladder 全段と
  // mcp/system の同格 blend を parity test の基準に固定する。

  it("source priority ladder を同 kind 内で固定する（idle<thinking<speech<persona<mcp<reflex）", () => {
    const ladder = ["idle", "thinking", "speech", "persona", "mcp", "reflex"] as const;
    for (let i = 0; i < ladder.length - 1; i++) {
      const lower = ladder[i];
      const higher = ladder[i + 1];
      if (!lower || !higher) continue;
      const mgr = new ExpressionManager();
      const low = mgr.addSlot(lower, "mood", "happy", 0.3);
      const high = mgr.addSlot(higher, "mood", "sad", 0.3);
      expect(mgr.getEffectiveWeight(low), `${lower} < ${higher}`).toBe(0);
      expect(mgr.getEffectiveWeight(high), `${lower} < ${higher}`).toBeCloseTo(0.3);
    }
  });

  it("mcp と system は同格で相互抑止せず blend し、reflex には両方とも譲る", () => {
    const mgr = new ExpressionManager();
    const mcp = mgr.addSlot("mcp", "mood", "sad", 0.3);
    const system = mgr.addSlot("system", "mood", "neutral", 0.4);
    expect(mgr.getEffectiveWeight(mcp)).toBeCloseTo(0.3);
    expect(mgr.getEffectiveWeight(system)).toBeCloseTo(0.4);

    const reflex = mgr.addSlot("reflex", "mood", "blink", 0.2);
    expect(mgr.getEffectiveWeight(mcp)).toBe(0);
    expect(mgr.getEffectiveWeight(system)).toBe(0);
    expect(mgr.getEffectiveWeight(reflex)).toBeCloseTo(0.2);
  });

  it("priority 抑止は同 kind 内に閉じる（異 kind の下位 source は生き残る）", () => {
    const mgr = new ExpressionManager();
    const idleCustom = mgr.addSlot("idle", "custom", "relaxed", 0.3);
    const personaMood = mgr.addSlot("persona", "mood", "happy", 0.4);
    // persona(2) > idle(0) だが kind が違う（custom vs mood）ので共存する
    expect(mgr.getEffectiveWeight(idleCustom)).toBeCloseTo(0.3);
    expect(mgr.getEffectiveWeight(personaMood)).toBeCloseTo(0.4);
  });

  it("detects active non-idle mood so Body can suspend idle overlays", () => {
    const mgr = new ExpressionManager();
    mgr.addSlot("idle", "mood", "neutral", 1);
    mgr.addSlot("idle", "custom", "relaxed", 0.4);
    expect(mgr.hasActiveNonIdleMood()).toBe(false);

    const happy = mgr.addSlot("persona", "mood", "happy", 0.6);
    expect(mgr.getEffectiveWeight(happy)).toBeCloseTo(0.6);
    expect(mgr.hasActiveNonIdleMood()).toBe(true);
  });

  it("ignores suppressed persona mood when a higher-priority mood owns the face", () => {
    const mgr = new ExpressionManager();
    const happy = mgr.addSlot("persona", "mood", "happy", 0.6);
    mgr.addSlot("mcp", "mood", "sad", 0.4);

    expect(mgr.getEffectiveWeight(happy)).toBe(0);
    expect(mgr.hasActiveNonIdleMood()).toBe(true);
  });
});

// ─── ExpressionSinkTracker ───────────────────────────────
//
// Body.applyExpressions の reset bug 対策。前 frame で書いた expression 名のうち、
// 今 frame の resolved に居ないものを sink 経由で 0 に戻す責務を担う。
// VRM 1.0 preset / viseme に限らず任意の blendshape 名（Fcl_* 等）も等しく扱う。

describe("ExpressionSinkTracker", () => {
  function recorder() {
    const writes: Array<[string, number]> = [];
    const sink = (name: string, weight: number) => {
      writes.push([name, weight]);
    };
    return { writes, sink };
  }

  it("first apply: writes every name in the batch", () => {
    const tracker = new ExpressionSinkTracker();
    const { writes, sink } = recorder();
    tracker.apply(
      new Map([
        ["happy", 0.5],
        ["aa", 0.3],
      ]),
      sink,
    );
    expect(writes).toHaveLength(2);
    expect(writes).toContainEqual(["happy", 0.5]);
    expect(writes).toContainEqual(["aa", 0.3]);
  });

  it("name dropped from batch on next apply gets zeroed via the sink", () => {
    const tracker = new ExpressionSinkTracker();
    tracker.apply(
      new Map([
        ["happy", 0.5],
        ["Fcl_BRW_Sorrow", 0.4],
      ]),
      () => {},
    );

    const { writes, sink } = recorder();
    tracker.apply(new Map([["happy", 0.5]]), sink);

    expect(writes).toContainEqual(["Fcl_BRW_Sorrow", 0]);
    expect(writes).toContainEqual(["happy", 0.5]);
  });

  it("name kept across frames is rewritten, never spuriously zeroed", () => {
    const tracker = new ExpressionSinkTracker();
    tracker.apply(new Map([["happy", 0.5]]), () => {});

    const { writes, sink } = recorder();
    tracker.apply(new Map([["happy", 0.3]]), sink);

    expect(writes).toEqual([["happy", 0.3]]);
  });

  it("empty batch after non-empty: zeroes everything written last frame", () => {
    const tracker = new ExpressionSinkTracker();
    tracker.apply(
      new Map([
        ["happy", 0.5],
        ["Fcl_BRW_Sorrow", 0.4],
      ]),
      () => {},
    );

    const { writes, sink } = recorder();
    tracker.apply(new Map(), sink);

    expect(writes).toHaveLength(2);
    expect(writes).toContainEqual(["happy", 0]);
    expect(writes).toContainEqual(["Fcl_BRW_Sorrow", 0]);
  });

  it("custom Fcl_* blendshapes are tracked the same as VRM 1.0 presets (regression)", () => {
    // ── Regression for the reset bug ─────────────────────────────────────
    // 旧 Body.applyExpressions は reset list が VRM 1.0 preset + visemes に
    // hardcode されており、Fcl_* 系 custom blendshape は slot release 後も
    // 直前の値を保持してしまっていた。tracker は名前を識別せず last-frame
    // tracking で zeroing するので、custom 名も等しく扱える。
    const tracker = new ExpressionSinkTracker();
    tracker.apply(new Map([["Fcl_EYE_Spread", 0.7]]), () => {});

    const { writes, sink } = recorder();
    tracker.apply(new Map(), sink);

    expect(writes).toEqual([["Fcl_EYE_Spread", 0]]);
  });

  it("re-adding a name after zeroing it works without leaking state", () => {
    const tracker = new ExpressionSinkTracker();
    tracker.apply(new Map([["Fcl_BRW_Joy", 0.6]]), () => {});
    tracker.apply(new Map(), () => {}); // zeroed here

    const { writes, sink } = recorder();
    tracker.apply(new Map([["Fcl_BRW_Joy", 0.4]]), sink);

    // 再 apply 時は zeroing は不要、新値だけ書く
    expect(writes).toEqual([["Fcl_BRW_Joy", 0.4]]);
  });
});

// ─── expressionTargetToName ──────────────────────────────

describe("expressionTargetToName", () => {
  it("maps mood preset", () => {
    expect(expressionTargetToName({ kind: "mood", preset: "happy" })).toBe("happy");
    expect(expressionTargetToName({ kind: "mood", preset: "sad" })).toBe("sad");
  });

  it("maps eye variant", () => {
    expect(expressionTargetToName({ kind: "eye", variant: "blink" })).toBe("blink");
    expect(expressionTargetToName({ kind: "eye", variant: "lookdown" })).toBe("lookdown");
  });

  it("maps lip phoneme", () => {
    expect(expressionTargetToName({ kind: "lip", phoneme: "aa" })).toBe("aa");
  });

  it("maps custom blendShapeName", () => {
    expect(expressionTargetToName({ kind: "custom", blendShapeName: "pout" })).toBe("pout");
  });

  it("maps part region+emotion to the Hana Tool Fcl_*_* morph name", () => {
    // 単発の sanity check
    expect(expressionTargetToName({ kind: "part", region: "brow", emotion: "sorrow" })).toBe(
      "Fcl_BRW_Sorrow",
    );
    expect(expressionTargetToName({ kind: "part", region: "eye", emotion: "joy" })).toBe(
      "Fcl_EYE_Joy",
    );
    expect(expressionTargetToName({ kind: "part", region: "mouth", emotion: "surprised" })).toBe(
      "Fcl_MTH_Surprised",
    );
  });

  it("part: every (region × emotion) combination resolves to the canonical Fcl_*_* name", () => {
    // 部位 prefix と emotion suffix の table と突き合わせる exhaustive check
    const REGION_PREFIX = { brow: "BRW", eye: "EYE", mouth: "MTH" } as const;
    const EMOTION_SUFFIX = {
      angry: "Angry",
      fun: "Fun",
      joy: "Joy",
      sorrow: "Sorrow",
      surprised: "Surprised",
    } as const;
    for (const region of ["brow", "eye", "mouth"] as const) {
      for (const emotion of ["angry", "fun", "joy", "sorrow", "surprised"] as const) {
        const name = expressionTargetToName({ kind: "part", region, emotion });
        expect(name).toBe(`Fcl_${REGION_PREFIX[region]}_${EMOTION_SUFFIX[emotion]}`);
      }
    }
  });
});

// ─── EyeSystem ───────────────────────────────────────────

describe("EyeSystem", () => {
  it("idle mode: output is within expected range", () => {
    const eye = new EyeSystem(() => 0.5);
    // Advance several seconds to trigger saccades
    for (let i = 0; i < 100; i++) eye.update(0.05);
    const out = eye.getOutput();
    expect(out.yaw).toBeGreaterThanOrEqual(-30);
    expect(out.yaw).toBeLessThanOrEqual(30);
    expect(out.pitch).toBeGreaterThanOrEqual(-25);
    expect(out.pitch).toBeLessThanOrEqual(25);
  });

  it("override: output matches override target", () => {
    const eye = new EyeSystem();
    eye.setOverride(15, -10);
    expect(eye.getOutput()).toEqual({ yaw: 15, pitch: -10 });
  });

  it("override pauses idle updates", () => {
    const eye = new EyeSystem(() => 0.5);
    // Get initial idle state
    for (let i = 0; i < 10; i++) eye.update(0.05);
    const beforeOverride = eye.getOutput();

    // Set override
    eye.setOverride(20, 5);
    expect(eye.getOutput()).toEqual({ yaw: 20, pitch: 5 });

    // Update several frames — idle should NOT advance
    for (let i = 0; i < 100; i++) eye.update(0.05);
    expect(eye.getOutput()).toEqual({ yaw: 20, pitch: 5 });

    // Release — should return to where idle was
    eye.releaseOverride(1); // first override ID is 1
    const afterRelease = eye.getOutput();
    // After release, idle resumes from paused state (same as beforeOverride)
    expect(afterRelease.yaw).toBeCloseTo(beforeOverride.yaw, 0);
    expect(afterRelease.pitch).toBeCloseTo(beforeOverride.pitch, 0);
  });

  it("new override replaces previous", () => {
    const eye = new EyeSystem();
    const id1 = eye.setOverride(10, 5);
    expect(eye.getOutput()).toEqual({ yaw: 10, pitch: 5 });

    const id2 = eye.setOverride(-15, 8);
    expect(eye.getOutput()).toEqual({ yaw: -15, pitch: 8 });
    expect(id2).not.toBe(id1);
  });

  it("stale override release has no effect", () => {
    const eye = new EyeSystem();
    const id1 = eye.setOverride(10, 5);
    eye.setOverride(-15, 8); // replaces id1

    eye.releaseOverride(id1); // stale — should be ignored
    expect(eye.getOutput()).toEqual({ yaw: -15, pitch: 8 });
    expect(eye.hasOverride).toBe(true);
  });

  it("hasOverride reflects state", () => {
    const eye = new EyeSystem();
    expect(eye.hasOverride).toBe(false);

    const id = eye.setOverride(0, 0);
    expect(eye.hasOverride).toBe(true);

    eye.releaseOverride(id);
    expect(eye.hasOverride).toBe(false);
  });

  it("ambient offset nudges idle and override gaze", () => {
    const eye = new EyeSystem(() => 0.5);
    eye.setAmbientOffset(8, 6);
    eye.update(1);
    const ambient = eye.getOutput();
    expect(ambient.yaw).toBeGreaterThan(0);
    expect(ambient.pitch).toBeGreaterThan(0);

    const id = eye.setOverride(2, -3);
    eye.update(1);
    expect(eye.getOutput()).toEqual({ yaw: 10, pitch: 3 });

    eye.releaseOverride(id);
    expect(eye.getOutput().yaw).toBeGreaterThan(0);
  });
});

// ─── CursorAttentionSystem ──────────────────────────────

describe("CursorAttentionSystem", () => {
  it("starts an episode after a randomized 8-15s delay", () => {
    const attention = new CursorAttentionSystem(() => 0);

    attention.update(7.9);
    expect(attention.isActive).toBe(false);

    attention.update(0.2);
    expect(attention.isActive).toBe(true);
    expect(attention.getOutput().mode).toBe("eyes");
  });

  it("triggerCursorAttention: episode starts immediately without waiting for ambient timer", () => {
    // ambient timer は 8〜15 秒だが trigger を呼ぶと即座に active になる
    const attention = new CursorAttentionSystem(() => 0);
    expect(attention.isActive).toBe(false);

    attention.triggerCursorAttention();
    expect(attention.isActive).toBe(true);
  });

  it("triggerCursorAttention: episode runs for the specified duration", () => {
    const attention = new CursorAttentionSystem(() => 0);
    attention.triggerCursorAttention(2.5);

    // 2.4 秒後はまだ active
    attention.update(2.4);
    expect(attention.isActive).toBe(true);

    // 2.5 秒を超えたら終了
    attention.update(0.2);
    expect(attention.isActive).toBe(false);
  });

  it("triggerCursorAttention: uses random duration when not specified", () => {
    // random が 0 → duration = DURATION_MIN_S = 1.0
    const attention = new CursorAttentionSystem(() => 0);
    attention.triggerCursorAttention();

    attention.update(0.9);
    expect(attention.isActive).toBe(true);

    attention.update(0.2);
    expect(attention.isActive).toBe(false);
  });

  it("triggerCursorAttention: emits start event with requested duration", () => {
    const events: unknown[] = [];
    const attention = new CursorAttentionSystem(
      () => 0,
      (e) => events.push(e),
    );

    attention.triggerCursorAttention(1.5);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "start", durationS: 1.5 });
  });

  it("source 変化検知パターン: 同 source の連続 snapshot では trigger は 1 回のみ", () => {
    // Body.initAttention の source-change ロジックを模倣したテスト
    let triggerCount = 0;
    const attention = new CursorAttentionSystem(() => 0);
    const origTrigger = attention.triggerCursorAttention.bind(attention);
    // triggerCursorAttention の呼び出し回数を計測するラッパー
    let lastSource: string | null = null;

    function handleSnapshot(source: string | null): void {
      if (source === null) {
        lastSource = null;
        return;
      }
      if (source !== lastSource) {
        triggerCount++;
        origTrigger();
      }
      lastSource = source;
    }

    // source A で 3 回連続 snapshot → trigger は 1 回
    handleSnapshot("mouse");
    handleSnapshot("mouse");
    handleSnapshot("mouse");
    expect(triggerCount).toBe(1);

    // source B に変化 → trigger が追加で 1 回
    handleSnapshot("terminal");
    expect(triggerCount).toBe(2);

    // null → source C → trigger が追加で 1 回
    handleSnapshot(null);
    handleSnapshot("input-cursor");
    expect(triggerCount).toBe(3);
  });

  it("briefly follows the pointer with a delayed, subtle output", () => {
    const values = [0, 0.5, 0.9];
    const attention = new CursorAttentionSystem(() => values.shift() ?? 0.5);

    attention.update(8);
    attention.setPointerPositionFromHead(1000, 0, 500, 500, 1000, 1000);
    attention.update(1 / 60);

    const out = attention.getOutput();
    expect(out.mode).toBe("both");
    expect(out.eyeYawDeg).toBeGreaterThan(0);
    expect(out.eyeYawDeg).toBeLessThan(72);
    expect(out.headYawRad).toBeGreaterThan(0);
    expect(out.headPitchRad).toBeGreaterThan(0);
  });

  it("computes pointer direction from the projected head position", () => {
    const values = [0, 0.5, 0.9];
    const attention = new CursorAttentionSystem(() => values.shift() ?? 0.5);

    attention.update(8);
    attention.setPointerPositionFromHead(700, 300, 500, 500, 1000, 1000);
    attention.update(1);

    const snapshot = attention.getDebugSnapshot();
    expect(snapshot.targetX).toBeGreaterThan(0);
    expect(snapshot.targetY).toBeGreaterThan(0);

    const out = attention.getOutput();
    expect(out.eyeYawDeg).toBeGreaterThan(0);
    expect(out.eyePitchDeg).toBeLessThan(0);
    expect(out.headYawRad).toBeGreaterThan(0);
    expect(out.headPitchRad).toBeGreaterThan(0);
  });

  it("applies eye output from the current target without lag", () => {
    const values = [0, 0.5, 0];
    const attention = new CursorAttentionSystem(() => values.shift() ?? 0.5);

    attention.update(8);
    attention.update(0.3);
    attention.setPointerPositionFromHead(850, 500, 500, 500, 1000, 1000);

    const out = attention.getOutput();
    const snapshot = attention.getDebugSnapshot();
    expect(snapshot.targetX).toBe(1);
    expect(snapshot.lagX).toBeLessThan(1);
    expect(out.eyeYawDeg).toBeCloseTo(56);
  });

  // ─── ambientGate ─────────────────────────────────────────

  it("ambientGate が true を返す場合: ambient タイマー発火で episode が開始する", () => {
    // random=0 → delay=8s、duration=1s
    const attention = new CursorAttentionSystem(
      () => 0,
      undefined,
      () => true,
    );

    attention.update(8.1);
    expect(attention.isActive).toBe(true);
  });

  it("ambientGate が false を返す場合: ambient タイマー発火で episode をスキップしタイマーをリセット", () => {
    // random=0 → delay=8s
    const attention = new CursorAttentionSystem(
      () => 0,
      undefined,
      () => false,
    );

    attention.update(8.1);
    // episode はスキップされる
    expect(attention.isActive).toBe(false);

    // タイマーが再セットされているため、さらに 8 秒待っても gate=false なら再スキップ
    attention.update(8.1);
    expect(attention.isActive).toBe(false);
  });

  it("ambientGate が undefined の場合: 後方互換で episode が開始する", () => {
    // gate 未指定 → 従来通り動作
    const attention = new CursorAttentionSystem(() => 0);

    attention.update(8.1);
    expect(attention.isActive).toBe(true);
  });

  it("triggerCursorAttention は gate=false でも episode を開始する（ゲート無視）", () => {
    // ambient gate は常に false だが、直接 trigger は通る
    const attention = new CursorAttentionSystem(
      () => 0,
      undefined,
      () => false,
    );

    // ambient では発火しない
    attention.update(8.1);
    expect(attention.isActive).toBe(false);

    // 直接 trigger → gate を無視して即時 episode 開始
    attention.triggerCursorAttention();
    expect(attention.isActive).toBe(true);
  });

  it("logs start and end events with duration and next delay", () => {
    const events: unknown[] = [];
    const values = [0, 0, 0.49, 1];
    const attention = new CursorAttentionSystem(
      () => values.shift() ?? 0,
      (event) => events.push(event),
    );

    attention.update(8);
    expect(events).toEqual([{ kind: "start", mode: "eyes", durationS: 1, nextDelayS: null }]);

    attention.update(1.1);
    expect(events).toEqual([
      { kind: "start", mode: "eyes", durationS: 1, nextDelayS: null },
      { kind: "end", mode: "eyes", durationS: 1, nextDelayS: 15 },
    ]);
  });
});

// ─── IdleSquintSystem ───────────────────────────────────

describe("IdleSquintSystem", () => {
  it("starts a subtle squint after a randomized idle delay", () => {
    const squint = new IdleSquintSystem(() => 1);

    expect(squint.update(21.9, true)).toBe(0);
    expect(squint.isActive).toBe(false);

    expect(squint.update(0.2, true)).toBe(0);
    expect(squint.isActive).toBe(true);

    const value = squint.update(0.08, true);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThanOrEqual(0.3);
  });

  it("randomizes each episode strength between 0.1 and 0.3", () => {
    const values = [0, 0, 0, 0, 0, 1];
    const squint = new IdleSquintSystem(() => values.shift() ?? 0);

    squint.update(8.1, true);
    squint.update(0.2, true);
    expect(squint.value).toBeCloseTo(0.1);

    squint.update(0.3, true);
    squint.update(8.1, true);
    squint.update(0.2, true);
    expect(squint.value).toBeCloseTo(0.3);
  });

  it("clears immediately when idle is disabled", () => {
    const squint = new IdleSquintSystem(() => 0);

    squint.update(8.1, true);
    squint.update(0.1, true);
    expect(squint.value).toBeGreaterThan(0);

    expect(squint.update(0.1, false)).toBe(0);
    expect(squint.value).toBe(0);
    expect(squint.isActive).toBe(false);
  });

  it("fades out and schedules another episode after duration", () => {
    const squint = new IdleSquintSystem(() => 0);

    squint.update(8.1, true);
    squint.update(0.1, true);
    expect(squint.value).toBeGreaterThan(0);

    expect(squint.update(0.4, true)).toBe(0);
    expect(squint.isActive).toBe(false);
  });
});

// ─── IdleMicroexpressionSystem ──────────────────────────
//
// Idle 中の Fcl_* morph 微震えで「神経の入った顔」を作る反射層。
// IdleSquintSystem に近いが、複数 morph を pool から選ぶ点と、
// (source, kind, name) ではなく event 形 ({morph, weight}) を返す点が違う。

describe("IdleMicroexpressionSystem", () => {
  it("starts inactive, only emits after the cooldown elapses", () => {
    const micro = new IdleMicroexpressionSystem(() => 0);
    // random=0 → cooldown=NEXT_MIN_S 相当
    expect(micro.update(0.5, true)).toBeNull();
    // cooldown を十分越える delta
    const event = micro.update(2.0, true);
    expect(event).not.toBeNull();
  });

  it("emits a morph from the configured pool", () => {
    const micro = new IdleMicroexpressionSystem(() => 0);
    micro.update(2.0, true);
    const event = micro.update(0.05, true);
    expect(event).not.toBeNull();
    if (event) {
      expect(MICRO_MORPH_POOL).toContain(event.morph);
    }
  });

  it("writeUpdate writes into the caller-provided event object", () => {
    const micro = new IdleMicroexpressionSystem(() => 0, ["Fcl_BRW_Joy"]);
    const out = { morph: "", weight: 0 };

    micro.writeUpdate(2.0, true, out);
    const event = micro.writeUpdate(0.05, true, out);

    expect(event).toBe(out);
    expect(out.morph).toBe("Fcl_BRW_Joy");
    expect(out.weight).toBeGreaterThan(0);
  });

  it("weight is positive during the episode and stays within configured bounds", () => {
    // random sequence で「最大 weight、最大 duration、最後の morph」を狙う
    const values = [0.999, 0.999, 0.999, 0.999];
    const micro = new IdleMicroexpressionSystem(() => values.shift() ?? 0);
    micro.update(4.1, true); // 越えれば始まる
    const event = micro.update(0.15, true); // fade window 内
    expect(event).not.toBeNull();
    if (event) {
      expect(event.weight).toBeGreaterThan(0);
      // 振幅上限は WEIGHT_MAX (=0.22)。fade window 中なので fade 倍率 ≤ 1。
      expect(event.weight).toBeLessThanOrEqual(0.22);
    }
  });

  it("disabling immediately clears any active event", () => {
    const micro = new IdleMicroexpressionSystem(() => 0);
    micro.update(2.0, true);
    micro.update(0.1, true);
    expect(micro.value).not.toBeNull();

    const next = micro.update(0.05, false);
    expect(next).toBeNull();
    expect(micro.value).toBeNull();
  });

  it("emits null after the episode duration elapses and schedules another", () => {
    const micro = new IdleMicroexpressionSystem(() => 0);
    micro.update(2.0, true); // start
    expect(micro.value).not.toBeNull();
    // random=0 → DURATION_MIN_S 短め (=0.25s)。十分越えれば終了。
    const after = micro.update(0.4, true);
    expect(after).toBeNull();
  });

  it("picks different morphs across episodes when randomness varies", () => {
    // 2 episode 観察: 1 回目は morph index=0、2 回目は最終 index
    const values = [
      0, // cooldown1
      0, // duration1
      0, // weight1
      0, // morph idx1 = 0
      0, // cooldown2
      0, // duration2
      0, // weight2
      0.99, // morph idx2 = pool.length-1
    ];
    const micro = new IdleMicroexpressionSystem(() => values.shift() ?? 0);

    micro.update(2.0, true);
    const first = micro.update(0.05, true);
    expect(first?.morph).toBe(MICRO_MORPH_POOL[0]);

    // 1 回目終了 + 2 回目開始
    micro.update(0.4, true);
    micro.update(2.0, true);
    const second = micro.update(0.05, true);
    expect(second?.morph).toBe(MICRO_MORPH_POOL[MICRO_MORPH_POOL.length - 1]);
  });

  it("injectEpisode で指定 morph の one-shot episode を注入できる", () => {
    const micro = new IdleMicroexpressionSystem(() => 0, ["Fcl_BRW_Joy"]);
    micro.injectEpisode("Fcl_BRW_Joy", 0.2, 0.4);
    const event = micro.update(0.12, true);
    expect(event?.morph).toBe("Fcl_BRW_Joy");
    expect(event?.weight).toBeGreaterThan(0);
  });

  it("pool getter は configured pool を read-only に公開する", () => {
    const pool = ["Fcl_BRW_Joy", "Fcl_BRW_Sorrow"];
    const micro = new IdleMicroexpressionSystem(() => 0, pool);
    expect(micro.pool).toEqual(pool);
  });
});

// ─── MICRO_*_POOL composition ────────────────────────────
//
// Pool 自体の中身が user-facing な振る舞いを決める（眉だけ動く、目だけ動く、口だけ動く、
// asymmetric が出る等）。各 region で「必須 morph が含まれている」ことを test として
// 固定する。Pool を入れ替えた時にここで気づける。

describe("MICRO_BROW_POOL", () => {
  it("contains Fcl_BRW_* emotion variants only", () => {
    for (const name of MICRO_BROW_POOL) {
      expect(name.startsWith("Fcl_BRW_")).toBe(true);
    }
  });
});

describe("MICRO_EYE_POOL", () => {
  it("contains Fcl_EYE_* variants only", () => {
    for (const name of MICRO_EYE_POOL) {
      expect(name.startsWith("Fcl_EYE_")).toBe(true);
    }
  });

  it("includes asymmetric L/R variants for wink-like twitches", () => {
    expect(MICRO_EYE_POOL).toContain("Fcl_EYE_Close_L");
    expect(MICRO_EYE_POOL).toContain("Fcl_EYE_Close_R");
    expect(MICRO_EYE_POOL).toContain("Fcl_EYE_Joy_L");
    expect(MICRO_EYE_POOL).toContain("Fcl_EYE_Joy_R");
  });
});

describe("MICRO_MOUTH_POOL", () => {
  it("contains Fcl_MTH_* variants only", () => {
    for (const name of MICRO_MOUTH_POOL) {
      expect(name.startsWith("Fcl_MTH_")).toBe(true);
    }
  });

  it("includes shapes for silent mouth life: small / close / up / down", () => {
    expect(MICRO_MOUTH_POOL).toContain("Fcl_MTH_Small");
    expect(MICRO_MOUTH_POOL).toContain("Fcl_MTH_Close");
    expect(MICRO_MOUTH_POOL).toContain("Fcl_MTH_Up");
    expect(MICRO_MOUTH_POOL).toContain("Fcl_MTH_Down");
  });

  it("includes への字 morph (Fcl_MTH_Angry) and a slight-smile morph (Fcl_MTH_Joy)", () => {
    expect(MICRO_MOUTH_POOL).toContain("Fcl_MTH_Angry");
    expect(MICRO_MOUTH_POOL).toContain("Fcl_MTH_Joy");
  });

  it("includes asymmetric SkinFung L/R for one-sided smirk", () => {
    expect(MICRO_MOUTH_POOL).toContain("Fcl_MTH_SkinFung_L");
    expect(MICRO_MOUTH_POOL).toContain("Fcl_MTH_SkinFung_R");
  });

  it("does not include visemes (aa/ih/ou/ee/oh) — lip sync owns those", () => {
    expect(MICRO_MOUTH_POOL).not.toContain("Fcl_MTH_A");
    expect(MICRO_MOUTH_POOL).not.toContain("Fcl_MTH_I");
    expect(MICRO_MOUTH_POOL).not.toContain("Fcl_MTH_U");
    expect(MICRO_MOUTH_POOL).not.toContain("Fcl_MTH_E");
    expect(MICRO_MOUTH_POOL).not.toContain("Fcl_MTH_O");
  });
});

describe("MICRO_MORPH_POOL (backward-compat aggregate)", () => {
  it("is the union of the three region pools", () => {
    const expected = new Set([...MICRO_BROW_POOL, ...MICRO_EYE_POOL, ...MICRO_MOUTH_POOL]);
    const actual = new Set(MICRO_MORPH_POOL);
    expect(actual).toEqual(expected);
  });
});

// ─── Body idle squint wiring ─────────────────────────────
//
// #83 M3 で idle squint の管理（intent / neutral 減衰 / blink suppression）
// は EyelidExpressionController から Body に移った。決定論化のため
// IdleSquintSystem を random 注入版に差し替える（8 秒で発火・weight 0.1）。

describe("Body idle squint wiring", () => {
  function injectDeterministicSquint(body: Body): void {
    (body as unknown as { idleSquint: IdleSquintSystem }).idleSquint = new IdleSquintSystem(
      () => 0,
    );
  }

  function idleEyeSlot(body: Body) {
    return body.getExpressionSlots().find((s) => s.source === "idle" && s.kind === "eye");
  }

  it("idle squint は旧配分 neutral=1-squint を維持しauto blinkを止める", () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    injectDeterministicSquint(body);
    const blinkSystem = (body as unknown as { blinkSystem: BlinkSystem }).blinkSystem;

    body.update(8.1, 0);
    body.update(0.2, 8.1);

    const squintSlot = idleEyeSlot(body);
    expect(squintSlot?.expressionName).toBe("blink");
    expect(squintSlot?.requestedWeight).toBeCloseTo(0.1);
    const neutral = body.getExpressionSlots().find((s) => s.source === "idle" && s.kind === "mood");
    expect(neutral?.requestedWeight).toBeCloseTo(0.9);
    expect(neutral?.effectiveWeight).toBeCloseTo(0.9);
    expect(squintSlot?.effectiveWeight).toBeCloseTo(0.1);
    expect(blinkSystem.isSuppressed).toBe(true);
  });

  it("explicit blink中もsquint episodeを維持しArbiterで抑止、releaseで即復帰する", () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    injectDeterministicSquint(body);

    const explicitBlink = body.acquireExpressionSlot("mcp", "eye", "blink", 0.8);
    body.update(8.1, 0);
    body.update(0.3, 8.1);

    expect(idleEyeSlot(body)?.requestedWeight).toBe(0);
    expect(
      body.getExpressionIntentSnapshot().intents.find((i) => i.owner.producerId === "idle-squint"),
    ).toMatchObject({ phase: "suppressed", reason: "ambient-suspended-by-grounded" });
    explicitBlink.release();
    body.update(0.01, 8.41);
    expect(idleEyeSlot(body)?.requestedWeight).toBeGreaterThan(0);
  });

  it("non-idle affect moodは別laneのsquint episodeを停止しない", () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    injectDeterministicSquint(body);
    const blinkSystem = (body as unknown as { blinkSystem: BlinkSystem }).blinkSystem;

    body.update(8.1, 0);
    body.update(0.2, 8.1);
    expect(idleEyeSlot(body)).toBeDefined();
    expect(blinkSystem.isSuppressed).toBe(true);

    body.acquireExpressionSlot("persona", "mood", "happy", 0.5);
    body.update(0.1, 8.3);

    expect(idleEyeSlot(body)?.requestedWeight).toBeGreaterThan(0);
    expect(blinkSystem.isSuppressed).toBe(true);
    expect(
      body.getExpressionIntentSnapshot().intents.find((i) => i.owner.producerId === "idle-squint")
        ?.phase,
    ).toMatch(/^(active|blended)$/);
  });

  it("startle safety blinkはidle squintとordinary blinkのpauseを越えて表示される", () => {
    const { vrm } = mockBodyVrm();
    const body = new Body(vrm, undefined, mockClaimState());
    injectDeterministicSquint(body);
    body.update(8.1, 0);
    body.update(0.2, 8.1);
    expect((body as unknown as { blinkSystem: BlinkSystem }).blinkSystem.isSuppressed).toBe(true);

    body.notifyStartle();
    body.update(0.025, 8.3);

    const snapshot = body.getExpressionIntentSnapshot();
    expect(snapshot.intents.find((i) => i.owner.producerId === "startle-blink")?.phase).toBe(
      "active",
    );
    expect(snapshot.intents.find((i) => i.owner.producerId === "idle-squint")).toMatchObject({
      phase: "suppressed",
      suppressedBy: expect.stringMatching(/^expr-intent-/),
    });
  });
});

// ─── gazeTargetToAngles ──────────────────────────────────

describe("gazeTargetToAngles", () => {
  it("camera: looks straight ahead", () => {
    const out = gazeTargetToAngles({ kind: "camera" });
    expect(out.yaw).toBe(0);
    expect(out.pitch).toBe(0);
  });

  it("away: non-zero yaw", () => {
    const out = gazeTargetToAngles({ kind: "away" }, () => 0.8);
    expect(Math.abs(out.yaw)).toBeGreaterThan(10);
  });

  it("point: forward direction gives ~0 yaw", () => {
    const out = gazeTargetToAngles({ kind: "point", direction: { x: 0, y: 0, z: 1 } });
    expect(out.yaw).toBeCloseTo(0, 0);
    expect(out.pitch).toBeCloseTo(0, 0);
  });

  it("point: right direction gives positive yaw", () => {
    const out = gazeTargetToAngles({ kind: "point", direction: { x: 1, y: 0, z: 1 } });
    expect(out.yaw).toBeGreaterThan(0);
  });

  it("screen-element: approximated as downward gaze", () => {
    const out = gazeTargetToAngles({ kind: "screen-element", selector: ".terminal" });
    expect(out.pitch).toBeLessThan(0); // looking down
  });
});

// ─── BlinkSystem ─────────────────────────────────────────

describe("BlinkSystem", () => {
  it("starts with value 0", () => {
    const blink = new BlinkSystem();
    expect(blink.value).toBe(0);
  });

  it("eventually produces a blink (value reaches 1.0)", () => {
    const blink = new BlinkSystem(() => 0); // min random → shortest interval
    let maxValue = 0;
    // Run for 10 seconds of simulated time
    for (let i = 0; i < 600; i++) {
      const v = blink.update(1 / 60);
      if (v > maxValue) maxValue = v;
    }
    expect(maxValue).toBe(1.0);
  });

  it("returns to 0 after blink completes", () => {
    const blink = new BlinkSystem(() => 0);
    // Fast forward until blink starts and finishes
    for (let i = 0; i < 600; i++) blink.update(1 / 60);
    // After enough time, should be back at 0
    for (let i = 0; i < 120; i++) blink.update(1 / 60);
    // Should have returned to 0 at some point
    expect(blink.value).toBe(0);
  });

  it("suppress stops blink generation", () => {
    const blink = new BlinkSystem(() => 0);
    blink.suppress();
    // Run for several seconds
    for (let i = 0; i < 600; i++) blink.update(1 / 60);
    expect(blink.value).toBe(0);
  });

  it("resume after suppress restarts blink cycle", () => {
    const blink = new BlinkSystem(() => 0);
    const token = blink.suppress();
    blink.resume(token);
    let maxValue = 0;
    for (let i = 0; i < 600; i++) {
      const v = blink.update(1 / 60);
      if (v > maxValue) maxValue = v;
    }
    expect(maxValue).toBe(1.0);
  });

  it("keeps blink suppressed until every suppression token is released", () => {
    const blink = new BlinkSystem(() => 0);
    const tokenA = blink.suppress();
    const tokenB = blink.suppress();

    blink.resume(tokenA);
    expect(blink.isSuppressed).toBe(true);
    for (let i = 0; i < 600; i++) blink.update(1 / 60);
    expect(blink.value).toBe(0);

    blink.resume(tokenB);
    expect(blink.isSuppressed).toBe(false);
  });

  it("values stay in [0, 1] range", () => {
    const blink = new BlinkSystem();
    for (let i = 0; i < 3600; i++) {
      const v = blink.update(1 / 60);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

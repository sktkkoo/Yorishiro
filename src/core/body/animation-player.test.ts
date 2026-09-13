import { type VRM, type VRMHumanBoneName, VRMHumanoid } from "@pixiv/three-vrm";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { AnimationPlayer } from "./animation-player";

describe("AnimationPlayer base pose capture", () => {
  it("clears procedural head pitch before AnimationMixer saves its restore pose", async () => {
    const scene = new THREE.Object3D();
    const head = new THREE.Object3D();
    head.name = "Head";
    scene.add(head);
    const vrm = { scene } as VRM;
    const beforeActionPlay = vi.fn(() => {
      head.rotation.x = 0;
    });
    const player = new AnimationPlayer(vrm, undefined, beforeActionPlay);
    const clip = new THREE.AnimationClip("head-motion", 1, [
      new THREE.QuaternionKeyframeTrack(
        "Head.quaternion",
        [0, 1],
        [0, 0, 0, 1, Math.sin(0.1), 0, 0, Math.cos(0.1)],
      ),
    ]);
    (player as unknown as { clipCache: Map<string, THREE.AnimationClip> }).clipCache.set(
      "anim:test-head-motion",
      clip,
    );

    // A cursor-attention episode left a temporary upward pitch on the bone.
    head.rotation.x = 0.14;
    const playback = await player.play("anim:test-head-motion", {
      fadeInMs: 0,
      fadeOutMs: 0,
      weight: 1,
    });
    player.update(0.5);
    playback.cancel();

    expect(beforeActionPlay).toHaveBeenCalledOnce();
    // stop() restores the clean pose captured after beforeActionPlay, not 0.14.
    expect(head.rotation.x).toBeCloseTo(0, 6);
  });
});

function rig() {
  const scene = new THREE.Object3D();
  const head = new THREE.Object3D();
  head.name = "Head";
  scene.add(head);
  const player = new AnimationPlayer({ scene } as VRM);
  const cache = (player as unknown as { clipCache: Map<string, THREE.AnimationClip> }).clipCache;
  const addClip = (ref: string, angles: number[], duration = 2) => {
    const clip = new THREE.AnimationClip(ref, duration, [
      new THREE.QuaternionKeyframeTrack(
        "Head.quaternion",
        angles.map((_, index) => (index * duration) / (angles.length - 1)),
        angles.flatMap((angle) => [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)]),
      ),
    ]);
    cache.set(ref, clip);
    return clip;
  };
  return { player, scene, head, cache, addClip };
}

function actionFor(player: AnimationPlayer, id: number) {
  const anim = (
    player as unknown as {
      active: Map<number, { action: THREE.AnimationAction }>;
    }
  ).active.get(id);
  if (!anim) throw new Error(`missing action ${id}`);
  return anim.action;
}

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("cached physical candidate evaluation", () => {
  const opts = {
    mask: "upper-body",
    loop: false,
    weight: 1,
    speed: 1,
    transition: "immediate",
  } as const;

  it("uses the requested contribution and the mixer's captured rest pose", async () => {
    const { player, head, addClip } = rig();
    addClip("pose", [1, 1]);
    await player.preload("pose", opts);
    head.rotation.x = 0.2;
    await player.play("pose", { ...opts, weight: 0.4, fadeInMs: 0 });
    player.update(1 / 60);
    player.update(1 / 60);
    expect(head.rotation.x).toBeCloseTo(0.52, 6);
    const weighted = player.evaluateTransition("pose", { ...opts, weight: 0.4 });
    const unweighted = player.evaluateTransition("pose", opts);
    expect(weighted?.cost).toBeLessThan(1e-10);
    expect(unweighted?.cost).toBeCloseTo(0.48 ** 2, 5);
    // Procedural offsets added after the mixer cannot change this decision.
    head.rotation.x = 2.5;
    expect(player.evaluateTransition("pose", { ...opts, weight: 0.4 })).toEqual(weighted);
  });

  it("evaluates the actual overlapping fade instead of the latest clip alone", async () => {
    const { player, head, addClip } = rig();
    addClip("left", [-0.6, -0.6]);
    addClip("right", [0.6, 0.6]);
    addClip("center", [0, 0]);
    for (const ref of ["left", "right", "center"]) await player.preload(ref, opts);
    await player.play("left", { ...opts, fadeInMs: 0 });
    player.update(1 / 60);
    await player.play("right", { ...opts, fadeInMs: 1200 });
    for (let i = 0; i < 36; i++) player.update(1 / 60);
    expect(player.activeCount).toBe(2);
    expect(head.rotation.x).toBeCloseTo(0, 6);
    const centered = player.evaluateTransition("center", opts);
    const latest = player.evaluateTransition("right", opts);
    expect(centered).not.toBeNull();
    expect(latest).not.toBeNull();
    if (!centered || !latest) throw new Error("Expected compatible candidates");
    expect(latest.cost - centered.cost).toBeCloseTo(0.36, 5);
    // A large pause invalidates velocity instead of fabricating a sudden kick.
    player.update(0.3);
    const snapshot = (
      player as unknown as { poseSnapshot: Map<string, { velocityValid: boolean }> }
    ).poseSnapshot;
    expect(snapshot.get("Head.quaternion")?.velocityValid).toBe(false);
  });

  it("fails closed for cold variants, incompatible poses, and unsupported full-body requests", async () => {
    const { player, addClip } = rig();
    addClip("remote-pose", [2, 2]);
    addClip("near-pose", [0.1, 0.1]);
    const load = vi.spyOn(
      player as unknown as { loadClip: (ref: string) => Promise<unknown> },
      "loadClip",
    );
    expect(player.evaluateTransition("near-pose", opts)).toBeNull();
    expect(load).not.toHaveBeenCalled();
    await player.preload("near-pose", opts);
    await player.preload("remote-pose", opts);
    load.mockClear();
    expect(player.evaluateTransition("near-pose", opts)).not.toBeNull();
    expect(player.evaluateTransition("near-pose", { ...opts, loop: true })).toBeNull();
    expect(player.evaluateTransition("remote-pose", opts)).toBeNull();
    expect(player.evaluateTransition("near-pose", { ...opts, mask: "full-body" })).toBeNull();
    expect(load).not.toHaveBeenCalled();
    expect(player.activeCount).toBe(0);
  });
});

describe("AnimationPlayer real mixer transitions", () => {
  it("crosses repeated recording seams with continuous pose and velocity", async () => {
    const { player, head, addClip } = rig();
    const raw = addClip("recording", [0.2, 0.8], 2);
    expect(await player.preload("recording", { loop: true })).toBe(true);
    const playback = await player.play("recording", { loop: true, fadeInMs: 0, weight: 1 });
    const loopTrack = actionFor(player, playback.id).getClip().tracks[0];
    const dt = 1 / 240;
    player.update(2 - dt);
    const before = head.rotation.x;
    player.update(dt);
    const atSeam = head.rotation.x;
    player.update(dt);
    const after = head.rotation.x;
    expect(Math.abs(atSeam - before)).toBeLessThan(0.002);
    expect(Math.abs((atSeam - before) / dt - (after - atSeam) / dt)).toBeLessThan(0.02);
    expect((after - atSeam) / dt).toBeCloseTo(0.3, 4);
    player.update(6);
    expect(head.rotation.x).toBeCloseTo(after, 4);
    player.stopAll();
    const repeated = await player.play("recording", { loop: true });
    expect(actionFor(player, repeated.id).getClip().tracks[0]).toBe(loopTrack);
    player.stopAll();
    const oneShot = await player.play("recording", { loop: false });
    expect(actionFor(player, oneShot.id).getClip().tracks[0]).toBe(raw.tracks[0]);
  });

  it("preserves authored speed when crossfading clips of different durations", async () => {
    const { player, addClip } = rig();
    addClip("short", [0, 0.2], 1);
    addClip("long", [0, 0.2], 8);
    const first = await player.play("short", { loop: true, fadeInMs: 0, speed: 0.8 });
    player.update(0.2);
    const second = await player.play("long", { loop: true, fadeInMs: 400, speed: 1.2 });
    for (let i = 0; i < 3; i++) {
      player.update(0.1);
      expect(actionFor(player, first.id).getEffectiveTimeScale()).toBeCloseTo(0.8, 6);
      expect(actionFor(player, second.id).getEffectiveTimeScale()).toBeCloseTo(1.2, 6);
    }
    expect(actionFor(player, second.id).time).toBeCloseTo(0.36, 6);
  });

  it("has gentle angular velocity at both crossfade endpoints", async () => {
    const { player, head, addClip } = rig();
    addClip("rest", [0, 0]);
    addClip("pose", [1, 1]);
    await player.play("rest", { loop: true, weight: 1, fadeInMs: 0 });
    player.update(0.1);
    await player.play("pose", { loop: true, weight: 1, fadeInMs: 200 });
    player.update(0.001);
    const startingVelocity = head.rotation.x / 0.001;
    player.update(0.198);
    const beforeEnd = head.rotation.x;
    player.update(0.001);
    const endingVelocity = (head.rotation.x - beforeEnd) / 0.001;
    // Linear crossfade of this pair starts/ends at 5 rad/s. Smoothstep stays < 0.1.
    expect(startingVelocity).toBeLessThan(0.1);
    expect(endingVelocity).toBeLessThan(0.1);
    expect(head.rotation.x).toBeCloseTo(1, 5);
    expect(player.activeCount).toBe(1);
  });

  it("selects a compatible phase only when matching is explicitly enabled", async () => {
    const make = async (matched: boolean) => {
      const { player, head, addClip } = rig();
      addClip("source", [0.5, 0.5], 3);
      addClip("target", [0, 0.5, 0.5, 0], 3);
      await player.play("source", { loop: true, weight: 1, fadeInMs: 0 });
      player.update(0.2);
      const playback = await player.play("target", {
        loop: true,
        weight: 1,
        fadeInMs: 0,
        transition: matched ? "matched" : "immediate",
        maxTransitionDelayMs: 0,
      });
      const entryTime = actionFor(player, playback.id).time;
      player.update(0);
      return { entryTime, error: Math.abs(head.rotation.x - 0.5) };
    };
    const baseline = await make(false);
    const matched = await make(true);
    expect(baseline.entryTime).toBe(0);
    expect(baseline.error).toBeCloseTo(0.5, 5);
    expect(matched.entryTime).toBeGreaterThan(1);
    expect(matched.error).toBeLessThan(0.02);
  });

  it("lets deterministic QA override the entry phase", async () => {
    const { player, head, addClip } = rig();
    addClip("motion", [0, 1], 2);
    const playback = await player.play("motion", {
      loop: true,
      weight: 1,
      fadeInMs: 0,
      startTimeSec: 1.5,
    });
    expect(actionFor(player, playback.id).time).toBe(1.5);
    player.update(0);
    expect(head.rotation.x).toBeCloseTo(0.75, 5);
  });

  it("masks hips and legs using normalized bone identity, including UUID tracks", async () => {
    const { scene, head } = rig();
    const hips = new THREE.Object3D();
    hips.name = "RetargetedPelvis";
    const leg = new THREE.Object3D();
    leg.name = "RetargetedLeg";
    scene.add(hips, leg);
    const vrm = {
      scene,
      humanoid: {
        getNormalizedBoneNode: (name: string) =>
          ({ hips, leftUpperLeg: leg, head })[name as "hips" | "leftUpperLeg" | "head"] ?? null,
      },
    } as unknown as VRM;
    const player = new AnimationPlayer(vrm);
    const tracks = ["Head", hips.name, leg.uuid].map(
      (name) =>
        new THREE.QuaternionKeyframeTrack(
          `${name}.quaternion`,
          [0, 1],
          [0, 0, 0, 1, Math.sin(0.4), 0, 0, Math.cos(0.4)],
        ),
    );
    (player as unknown as { clipCache: Map<string, THREE.AnimationClip> }).clipCache.set(
      "motion",
      new THREE.AnimationClip("motion", 1, tracks),
    );
    await player.play("motion", { weight: 1, fadeInMs: 0, mask: "upper-body" });
    player.update(0.5);
    expect(head.rotation.x).toBeCloseTo(0.4, 5);
    expect(hips.rotation.x).toBe(0);
    expect(leg.rotation.x).toBe(0);
    player.stopAll();
    await player.play("motion", { weight: 1, fadeInMs: 0, mask: "full-body" });
    player.update(0.5);
    expect(hips.rotation.x).toBeCloseTo(0.4, 5);
    expect(leg.rotation.x).toBeCloseTo(0.4, 5);
  });
});

describe("AnimationPlayer action ownership", () => {
  it.each([
    false,
    true,
  ])("retires outgoing fades before freezing without resurrecting them (current cancelled: %s)", async (cancelCurrent) => {
    const { player, addClip } = rig();
    addClip("outgoing", [0.5, 0.5]);
    addClip("current", [0.8, 0.8]);
    const outgoing = await player.play("outgoing", { loop: true, fadeInMs: 0 });
    player.update(0.1);
    const current = await player.play("current", { loop: true, fadeInMs: 400 });
    const currentAction = actionFor(player, current.id);
    if (cancelCurrent) current.cancel();
    player.retireFadingActions();
    await outgoing.completion;
    expect(player.activeCount).toBe(cancelCurrent ? 0 : 1);
    player.update(1);
    expect(player.activeCount).toBe(cancelCurrent ? 0 : 1);
    expect(currentAction.isRunning()).toBe(!cancelCurrent);
  });

  it("tracks stopAll fades through cleanup and restores the base pose", async () => {
    const { player, head, addClip } = rig();
    addClip("motion", [0.7, 0.7]);
    const playback = await player.play("motion", { loop: true, weight: 1, fadeInMs: 0 });
    player.update(0.1);
    player.stopAll(200);
    expect(player.activeCount).toBe(1);
    player.update(0.1);
    expect(player.getTotalEffectiveWeight()).toBeCloseTo(0.5, 5);
    player.update(0.101);
    await playback.completion;
    expect(player.activeCount).toBe(0);
    expect(player.getTotalEffectiveWeight()).toBe(0);
    expect(head.rotation.x).toBeCloseTo(0, 5);
    player.update(1);
    expect(head.rotation.x).toBeCloseTo(0, 5);
  });

  it("replays the same clip independently of old stop promises and cancel handles", async () => {
    const { player, head, addClip } = rig();
    addClip("motion", [0, 1], 2);
    const old = await player.play("motion", { loop: true, weight: 1, fadeInMs: 0 });
    player.update(0.8);
    const oldAction = actionFor(player, old.id);
    const stopped = old.stop(400);
    const next = await player.play("motion", { loop: true, weight: 1, fadeInMs: 200 });
    const nextAction = actionFor(player, next.id);
    expect(oldAction).not.toBe(nextAction);
    player.update(0.201);
    await stopped;
    old.cancel();
    expect(player.activeCount).toBe(1);
    expect(nextAction.isRunning()).toBe(true);
    player.update(0.2);
    expect(head.rotation.x).toBeCloseTo(0.2005, 4);
    expect(oldAction.isRunning()).toBe(false);
  });

  it("auto-fades completed one-shots using mixer time without timers", async () => {
    const { player, head, addClip } = rig();
    addClip("motion", [0, 1], 1);
    const playback = await player.play("motion", { weight: 1, fadeInMs: 0, fadeOutMs: 200 });
    player.update(1.001);
    await playback.completion;
    expect(head.rotation.x).toBeCloseTo(1, 5);
    player.update(0.1);
    expect(player.getTotalEffectiveWeight()).toBeCloseTo(0.5, 5);
    player.update(0.101);
    expect(player.activeCount).toBe(0);
    expect(head.rotation.x).toBeCloseTo(0, 5);
  });

  it("does not start a late-loaded action after stopAll", async () => {
    const { player, addClip } = rig();
    const clip = addClip("motion", [0, 1]);
    const loaded = deferred<THREE.AnimationClip>();
    vi.spyOn(
      player as unknown as { loadClip: () => Promise<THREE.AnimationClip> },
      "loadClip",
    ).mockReturnValueOnce(loaded.promise);
    const play = player.play("motion");
    player.stopAll();
    loaded.resolve(clip);
    await expect(play).rejects.toMatchObject({ name: "AbortError" });
    expect(player.activeCount).toBe(0);
  });

  it("checks scheduler ownership after asynchronous loading", async () => {
    const { player, addClip } = rig();
    const clip = addClip("motion", [0, 1]);
    const loaded = deferred<THREE.AnimationClip>();
    vi.spyOn(
      player as unknown as { loadClip: () => Promise<THREE.AnimationClip> },
      "loadClip",
    ).mockReturnValueOnce(loaded.promise);
    let current = true;
    const play = player.play("motion", { isCurrent: () => current });
    current = false;
    loaded.resolve(clip);
    await expect(play).rejects.toMatchObject({ name: "AbortError" });
    expect(player.activeCount).toBe(0);
  });

  it("cancels a pending quiet-window transition when stopAll invalidates it", async () => {
    const { player, cache, addClip } = rig();
    cache.set(
      "source",
      new THREE.AnimationClip("source", 1, [
        new THREE.QuaternionKeyframeTrack(
          "Head.quaternion",
          [0, 0.1, 0.2, 1],
          [0, 0.4, 0.4, 0.4].flatMap((angle) => [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)]),
        ),
      ]),
    );
    addClip("target", [0.4, 0.4]);
    await player.play("source", { loop: true, fadeInMs: 0 });
    const pending = player.play("target", { transition: "matched", maxTransitionDelayMs: 250 });
    // loadClip has two microtask boundaries before a cached clip is ready.
    await Promise.resolve();
    await Promise.resolve();
    player.stopAll();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(player.activeCount).toBe(0);
  });

  it("prepares a masked clip without activating or disturbing the current pose", async () => {
    const { player, head, addClip } = rig();
    addClip("motion", [0.4, 0.4]);
    head.rotation.x = 0.2;
    expect(await player.preload("motion", { mask: "upper-body" })).toBe(true);
    expect(player.activeCount).toBe(0);
    expect(head.rotation.x).toBeCloseTo(0.2, 6);
    expect(await player.preload("motion", { isCurrent: () => false })).toBe(false);
  });
});

function foundationRig() {
  const scene = new THREE.Object3D();
  const head = new THREE.Object3D();
  head.name = "Head";
  const hips = new THREE.Object3D();
  hips.name = "RetargetedPelvis";
  const leg = new THREE.Object3D();
  leg.name = "RetargetedLeg";
  scene.add(head, hips, leg);
  const bones: Partial<Record<string, THREE.Object3D>> = { head, hips, leftUpperLeg: leg };
  const vrm = {
    scene,
    humanoid: { getNormalizedBoneNode: (name: string) => bones[name] ?? null },
  } as unknown as VRM;
  const player = new AnimationPlayer(vrm);
  const cache = (player as unknown as { clipCache: Map<string, THREE.AnimationClip> }).clipCache;
  const addClip = (ref: string, headAngles = [0.2, 0.2], duration = 2) => {
    const rotationTrack = (name: string, angles: number[]) =>
      new THREE.QuaternionKeyframeTrack(
        `${name}.quaternion`,
        angles.map((_, index) => (index * duration) / (angles.length - 1)),
        angles.flatMap((angle) => [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)]),
      );
    cache.set(
      ref,
      new THREE.AnimationClip(ref, duration, [
        rotationTrack(head.name, headAngles),
        rotationTrack(hips.name, [0.4, 0.4]),
        rotationTrack(leg.uuid, [-0.3, -0.3]),
        new THREE.VectorKeyframeTrack(`${hips.name}.position`, [0, duration], [0, 0, 0, 1, 2, 3]),
      ]),
    );
  };
  addClip("recording");
  return { player, head, hips, leg, addClip };
}

describe("AnimationPlayer recorded foundation layer", () => {
  it("mixes disjoint recorded lower and upper bones with independent effective weights", async () => {
    const { player, head, hips, leg } = foundationRig();
    expect(await player.preload("recording", { mask: "lower-body", loop: true })).toBe(true);
    await player.play("recording", {
      layer: "foundation",
      mask: "lower-body",
      loop: true,
      weight: 0.6,
      fadeInMs: 0,
    });
    await player.play("recording", { mask: "upper-body", loop: true, weight: 0.8, fadeInMs: 0 });
    player.update(0.25);
    expect(player.activeCount).toBe(2);
    expect(player.getTotalEffectiveWeight()).toBeCloseTo(0.8, 6);
    expect(player.getFoundationEffectiveWeight()).toBeCloseTo(0.6, 6);
    expect(head.rotation.x).toBeCloseTo(0.16, 5);
    expect(hips.rotation.x).toBeCloseTo(0.24, 5);
    expect(leg.rotation.x).toBeCloseTo(-0.18, 5);
    expect(hips.position.length()).toBe(0);
  });

  it("replaces an upper-body performance while the same foundation action keeps playing", async () => {
    const { player, addClip } = foundationRig();
    addClip("next", [0.6, 0.6]);
    const foundation = await player.play("recording", {
      layer: "foundation",
      mask: "lower-body",
      loop: true,
      weight: 1,
      fadeInMs: 0,
    });
    const foundationAction = actionFor(player, foundation.id);
    const outgoing = await player.play("recording", {
      mask: "upper-body",
      loop: true,
      fadeInMs: 0,
    });
    player.update(0.2);
    const incoming = await player.play("next", { mask: "upper-body", loop: true, fadeInMs: 400 });
    player.update(0.401);
    await outgoing.completion;
    expect(player.activeCount).toBe(2);
    expect(actionFor(player, foundation.id)).toBe(foundationAction);
    expect(foundationAction.time).toBeCloseTo(0.601, 6);
    expect(foundationAction.isRunning()).toBe(true);
    expect(player.getFoundationEffectiveWeight()).toBeCloseTo(1, 6);
    expect(actionFor(player, incoming.id).isRunning()).toBe(true);
  });

  it("matches an incoming performance against its own layer even when foundation started last", async () => {
    const { player, addClip } = foundationRig();
    addClip("pose", [0.5, 0.5], 3);
    addClip("target", [0, 0.5, 0.5, 0], 3);
    await player.play("pose", { mask: "upper-body", loop: true, weight: 1, fadeInMs: 0 });
    player.update(0.2);
    const foundation = await player.play("recording", {
      layer: "foundation",
      mask: "lower-body",
      loop: true,
      fadeInMs: 0,
    });
    const incoming = await player.play("target", {
      mask: "upper-body",
      loop: true,
      transition: "matched",
      maxTransitionDelayMs: 0,
      fadeInMs: 0,
    });
    expect(actionFor(player, incoming.id).time).toBeGreaterThan(1);
    expect(actionFor(player, foundation.id).isRunning()).toBe(true);
    expect(player.activeCount).toBe(2);
  });

  it("stops and restores both layers through a single stopAll fade", async () => {
    const { player, head, hips, leg } = foundationRig();
    const foundation = await player.play("recording", {
      layer: "foundation",
      mask: "lower-body",
      loop: true,
      weight: 1,
      fadeInMs: 0,
    });
    const performance = await player.play("recording", {
      mask: "upper-body",
      loop: true,
      weight: 1,
      fadeInMs: 0,
    });
    player.update(0.1);
    player.stopAll(200);
    player.update(0.1);
    expect(player.getFoundationEffectiveWeight()).toBeCloseTo(0.5, 6);
    expect(player.getTotalEffectiveWeight()).toBeCloseTo(0.5, 6);
    player.update(0.101);
    await Promise.all([foundation.completion, performance.completion]);
    expect(player.activeCount).toBe(0);
    expect(player.getFoundationEffectiveWeight()).toBe(0);
    expect(player.getTotalEffectiveWeight()).toBe(0);
    expect(head.rotation.x).toBeCloseTo(0, 6);
    expect(hips.rotation.x).toBeCloseTo(0, 6);
    expect(leg.rotation.x).toBeCloseTo(0, 6);
  });
});

describe("AnimationPlayer bounded semantic one-shots", () => {
  it("finishes a long recording at a low-velocity exit within 500 ms after its cap", async () => {
    const { player, cache } = rig();
    cache.set(
      "long-gesture",
      new THREE.AnimationClip("long-gesture", 10, [
        new THREE.QuaternionKeyframeTrack(
          "Head.quaternion",
          [0, 5.9, 6.2, 10],
          [0, 0, 0.6, 0.6].flatMap((angle) => [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)]),
        ),
      ]),
    );
    const gesture = await player.play("long-gesture", {
      fadeInMs: 0,
      fadeOutMs: 600,
      weight: 1,
      maxDurationMs: 6_000,
    });
    let completionTime: number | undefined;
    let time = 5.99;
    void gesture.completion.then(() => {
      completionTime = time;
    });
    player.update(time);
    await Promise.resolve();
    expect(completionTime).toBeUndefined();
    for (let step = 0; step < 24 && completionTime === undefined; step++) {
      time += 0.025;
      player.update(0.025);
      await Promise.resolve();
    }
    expect(completionTime).toBeGreaterThan(6.1);
    expect(completionTime).toBeLessThanOrEqual(6.525);
    expect(player.activeCount).toBe(1);
    player.update(0.3);
    expect(player.getTotalEffectiveWeight()).toBeCloseTo(0.5, 4);
    player.update(0.301);
    expect(player.activeCount).toBe(0);
  });

  it.each([3, 5.6])("preserves natural completion for a %s second gesture", async (duration) => {
    const { player, addClip } = rig();
    addClip("short-gesture", [0, 0.5], duration);
    const gesture = await player.play("short-gesture", {
      fadeInMs: 0,
      fadeOutMs: 600,
      maxDurationMs: 6_000,
    });
    let completed = false;
    void gesture.completion.then(() => {
      completed = true;
    });
    player.update(duration - 0.01);
    await Promise.resolve();
    expect(completed).toBe(false);
    player.update(0.02);
    await gesture.completion;
    expect(completed).toBe(true);
    expect(player.activeCount).toBe(1);
    player.update(0.601);
    expect(player.activeCount).toBe(0);
  });

  it("never caps the persistent looping speech baseline or foundation", async () => {
    const { player, addClip } = rig();
    addClip("loop", [0.3, 0.3]);
    const loop = await player.play("loop", {
      loop: true,
      maxDurationMs: 500,
      fadeInMs: 0,
    });
    let completed = false;
    void loop.completion.then(() => {
      completed = true;
    });
    player.update(3);
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(actionFor(player, loop.id).isRunning()).toBe(true);
    expect(player.activeCount).toBe(1);
  });

  it("does not let a retired recording's cap stop its replacement or extend a prior stop", async () => {
    const { player, addClip } = rig();
    addClip("gesture", [0.3, 0.3], 10);
    const first = await player.play("gesture", { maxDurationMs: 1_000, fadeInMs: 0 });
    player.update(0.8);
    const second = await player.play("gesture", { maxDurationMs: 2_000, fadeInMs: 100 });
    player.update(0.4);
    await first.completion;
    expect(player.activeCount).toBe(1);
    expect(actionFor(player, second.id).isRunning()).toBe(true);
    const stopped = second.stop(100);
    player.update(0.101);
    await stopped;
    player.update(5);
    expect(player.activeCount).toBe(0);
  });
});

function standingRig() {
  const scene = new THREE.Object3D();
  const hips = new THREE.Object3D();
  hips.name = "hips";
  hips.position.set(0, 0.9, 0);
  scene.add(hips);
  const rawBones = new Map<VRMHumanBoneName, THREE.Object3D>([["hips", hips]]);
  for (const side of ["left", "right"] as const) {
    let parent = hips;
    for (const part of ["UpperLeg", "LowerLeg", "Foot", "Toes"] as const) {
      const name = `${side}${part}` as VRMHumanBoneName;
      const bone = new THREE.Object3D();
      bone.name = name;
      if (part === "UpperLeg") bone.position.x = side === "left" ? 0.09 : -0.09;
      else if (part === "Toes") bone.position.set(0, -0.05, 0.12);
      else bone.position.y = -0.4;
      parent.add(bone);
      rawBones.set(name, bone);
      parent = bone;
    }
  }
  scene.updateMatrixWorld(true);
  const humanoid = new VRMHumanoid(
    // The mixer fixture deliberately contains only the normalized lower body.
    Object.fromEntries(
      [...rawBones].map(([name, node]) => [name, { node }]),
    ) as unknown as ConstructorParameters<typeof VRMHumanoid>[0],
  );
  scene.add(humanoid.normalizedHumanBonesRoot);
  const vrm = { scene, humanoid } as unknown as VRM;
  const tracks = [...rawBones.keys()].map((name) => {
    const bone = humanoid.getNormalizedBoneNode(name);
    if (!bone) throw new Error(`missing standing bone ${name}`);
    const angles = name === "hips" ? [0.12, 0.13, 0.12] : [0, 0, 0];
    return new THREE.QuaternionKeyframeTrack(
      `${bone.uuid}.quaternion`,
      [0, 1, 2],
      angles.flatMap((angle) => [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)]),
    );
  });
  const original = new THREE.AnimationClip("reviewed-idle", 2, tracks);
  const player = new AnimationPlayer(vrm);
  const cache = (player as unknown as { clipCache: Map<string, THREE.AnimationClip> }).clipCache;
  cache.set("anim:Idle", original);
  cache.set("anim:OtherIdle", original);
  return { player, vrm, original };
}

describe("AnimationPlayer reviewed standing Idle preparation", () => {
  it("fails closed for an avatar missing a required support bone", async () => {
    const { player, vrm } = standingRig();
    const getBone = vrm.humanoid.getNormalizedBoneNode.bind(vrm.humanoid);
    vi.spyOn(vrm.humanoid, "getNormalizedBoneNode").mockImplementation((name) =>
      name === "rightToes" ? null : getBone(name),
    );
    expect(await player.preload("anim:Idle", { mask: "lower-body", loop: true })).toBe(false);
    await expect(
      player.play("anim:Idle", {
        layer: "foundation",
        mask: "lower-body",
        loop: true,
      }),
    ).rejects.toThrow("Unable to calibrate");
    expect(player.activeCount).toBe(0);
    expect(player.getFoundationEffectiveWeight()).toBe(0);
  });

  it.each([
    { delta: 0.3, error: "Unable to calibrate" },
    { delta: 0.09, error: "Unable to ground" },
  ])("rejects an unsuitable foundation rather than playing an unsafe stance: $error", async ({
    delta,
    error,
  }) => {
    const { player, original } = standingRig();
    const angle = 0.12 + delta;
    original.tracks[0].values.set([Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)], 4);
    expect(await player.preload("anim:Idle", { mask: "lower-body", loop: true })).toBe(false);
    await expect(
      player.play("anim:Idle", {
        layer: "foundation",
        mask: "lower-body",
        loop: true,
      }),
    ).rejects.toThrow(error);
    expect(player.activeCount).toBe(0);
    // Explicit full-body playback remains available to its own caller.
    const explicit = await player.play("anim:Idle", { loop: false });
    expect(actionFor(player, explicit.id).getClip().tracks).toBe(original.tracks);
  });

  it("calibrates, closes and grounds only the reviewed lower-body variant, and reuses its cache", async () => {
    const { player, vrm, original } = standingRig();
    const hips = vrm.humanoid.getNormalizedBoneNode("hips");
    const foot = vrm.humanoid.getNormalizedBoneNode("leftFoot");
    if (!hips || !foot) throw new Error("standing fixture must contain hips and feet");
    const originalValues = [...original.tracks[0].values];
    await player.preload("anim:Idle", { mask: "lower-body", loop: true });
    expect(hips.rotation.x).toBeCloseTo(0, 6);
    expect(player.activeCount).toBe(0);
    const foundation = await player.play("anim:Idle", {
      layer: "foundation",
      mask: "lower-body",
      loop: true,
      weight: 1,
      fadeInMs: 0,
    });
    const preparedTracks = actionFor(player, foundation.id).getClip().tracks;
    expect(preparedTracks.filter((track) => track.name.endsWith(".position"))).toHaveLength(1);
    player.update(0);
    const initialFoot = foot.getWorldPosition(new THREE.Vector3());
    expect(hips.rotation.x).toBeCloseTo(0, 6);
    player.update(1);
    expect(hips.rotation.x).toBeCloseTo(0.01, 5);
    expect(foot.getWorldPosition(new THREE.Vector3()).distanceTo(initialFoot)).toBeLessThan(0.0015);
    expect([...original.tracks[0].values]).toEqual(originalValues);
    player.stopAll();

    const unreviewed = await player.play("anim:OtherIdle", {
      layer: "foundation",
      mask: "lower-body",
      loop: true,
      weight: 1,
      fadeInMs: 0,
    });
    expect(
      actionFor(player, unreviewed.id)
        .getClip()
        .tracks.some((track) => track.name.endsWith(".position")),
    ).toBe(false);
    player.update(0);
    expect(hips.rotation.x).toBeCloseTo(0.12, 5);
    player.stopAll();

    const replay = await player.play("anim:Idle", {
      layer: "foundation",
      mask: "lower-body",
      loop: true,
      fadeInMs: 0,
    });
    expect(actionFor(player, replay.id).getClip().tracks).toBe(preparedTracks);
    player.stopAll();
    const explicit = await player.play("anim:Idle", { loop: false, fadeInMs: 0 });
    expect(actionFor(player, explicit.id).getClip().tracks).toBe(original.tracks);
  });
});

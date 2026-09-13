import type { VRM } from "@pixiv/three-vrm";
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

describe("AnimationPlayer real mixer transitions", () => {
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

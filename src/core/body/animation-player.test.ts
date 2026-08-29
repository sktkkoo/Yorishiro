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

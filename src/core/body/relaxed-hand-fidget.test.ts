import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { RelaxedHandFidget } from "./relaxed-hand-fidget";

function fixture(metaVersion: "0" | "1" = "1", random: () => number = () => 0) {
  const scene = new THREE.Object3D();
  const bones = new Map<string, THREE.Object3D>();
  for (const side of ["left", "right"]) {
    for (const suffix of [
      "UpperArm",
      "Hand",
      "ThumbMetacarpal",
      "ThumbProximal",
      "ThumbDistal",
      ...["Index", "Middle", "Ring", "Little"].flatMap((finger) =>
        ["Proximal", "Intermediate", "Distal"].map((joint) => finger + joint),
      ),
    ]) {
      const node = new THREE.Object3D();
      node.name = side + suffix;
      scene.add(node);
      bones.set(node.name, node);
    }
  }
  const vrm = {
    scene,
    meta: { metaVersion },
    humanoid: { getNormalizedBoneNode: (name: VRMHumanBoneName) => bones.get(name) ?? null },
  } as unknown as VRM;
  const fidget = new RelaxedHandFidget(vrm, { random });
  const node = (name: string) => {
    const bone = bones.get(name);
    if (!bone) throw new Error(name);
    return bone;
  };
  return { fidget, scene, bones, node, vrm };
}

function advance(fidget: RelaxedHandFidget, seconds: number, enabled = true): void {
  for (let index = 0; index < Math.round(seconds * 10); index++) fidget.update(0.1, enabled);
}

describe("relaxed recorded-hand supplement", () => {
  it("waits for quiet eligibility, then curls one hand without touching thumb, wrist or arm", () => {
    const { fidget, node } = fixture();
    advance(fidget, 60, false);
    advance(fidget, 17.8);
    expect(node("leftIndexIntermediate").rotation.z).toBeCloseTo(0, 12);
    advance(fidget, 1.3);
    expect(node("leftIndexIntermediate").rotation.z).toBeCloseTo(-0.18, 3);
    expect(node("leftLittleIntermediate").rotation.z).toBeCloseTo(-0.25, 3);
    for (const name of [
      "rightIndexIntermediate",
      "leftThumbProximal",
      "leftThumbMetacarpal",
      "leftHand",
      "leftUpperArm",
    ])
      expect(node(name).quaternion.equals(new THREE.Quaternion())).toBe(true);
    advance(fidget, 1.2);
    expect(node("leftIndexIntermediate").rotation.z).toBeCloseTo(0, 12);
  });

  it("keeps actual mixer finger curves underneath the curl and restores the current source pose", () => {
    const { fidget, node, scene } = fixture();
    const finger = node("leftIndexIntermediate");
    const track = new THREE.QuaternionKeyframeTrack(
      `${finger.name}.quaternion`,
      [0, 60],
      [0.25, 0.55].flatMap((angle) =>
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -angle).toArray(),
      ),
    );
    const mixer = new THREE.AnimationMixer(scene);
    mixer.clipAction(new THREE.AnimationClip("recorded-fingers", 60, [track])).play();
    let sawCurl = false;
    for (let frame = 0; frame < 205; frame++) {
      fidget.restoreBaseRotations();
      mixer.update(0.1);
      const source = finger.quaternion.clone();
      fidget.update(0.1, true);
      const difference = source.angleTo(finger.quaternion);
      expect(difference).toBeLessThanOrEqual(0.180001);
      sawCurl ||= difference > 0.17;
      if (frame === 190) {
        fidget.restoreBaseRotations();
        expect(finger.quaternion.angleTo(source)).toBeLessThan(1e-7);
      }
    }
    expect(sawCurl).toBe(true);
    fidget.restoreBaseRotations();
    mixer.update(0.1);
    const source = finger.quaternion.clone();
    fidget.update(0.1, false);
    expect(finger.quaternion.angleTo(source)).toBeLessThan(1e-7);
  });

  it("writes nothing in the first semantic/claimed frame and preserves a newer direct pose owner", () => {
    const { fidget, node } = fixture();
    const finger = node("leftIndexIntermediate");
    advance(fidget, 19.1);
    expect(Math.abs(finger.rotation.z)).toBeGreaterThan(0.17);
    fidget.restoreBaseRotations();
    finger.rotation.set(0.12, -0.07, -0.8); // New semantic mixer result.
    const semantic = finger.quaternion.clone();
    fidget.update(0.1, false);
    expect(finger.quaternion.equals(semantic)).toBe(true);
    advance(fidget, 19.1);
    finger.rotation.set(-0.2, 0.11, 0.6); // Direct owner writes before restore.
    const manual = finger.quaternion.clone();
    fidget.update(0.1, false);
    expect(finger.quaternion.equals(manual)).toBe(true);
    advance(fidget, 17.8);
    expect(finger.quaternion.equals(manual)).toBe(true);
  });

  it("alternates hands with an 18-second or longer rest between two-second episodes", () => {
    const { fidget, node } = fixture();
    const episodes: { side: string; start: number; end: number }[] = [];
    let active: (typeof episodes)[number] | undefined;
    for (let frame = 0; frame < 500; frame++) {
      fidget.update(0.1, true);
      const side =
        Math.abs(node("leftIndexIntermediate").rotation.z) > 1e-8
          ? "left"
          : Math.abs(node("rightIndexIntermediate").rotation.z) > 1e-8
            ? "right"
            : null;
      if (side && !active) {
        active = { side, start: frame / 10, end: 0 };
        episodes.push(active);
      }
      if (!side && active) {
        active.end = frame / 10;
        active = undefined;
      }
    }
    expect(episodes.map((episode) => episode.side)).toEqual(["left", "right"]);
    expect(episodes[1].start - episodes[0].end).toBeGreaterThanOrEqual(18);
    expect(episodes[0].end - episodes[0].start).toBeCloseTo(1.9, 1);
  });

  it("uses the same mirrored palm-side axes as the VRM rest pose", () => {
    for (const version of ["0", "1"] as const) {
      const { fidget, node } = fixture(version);
      advance(fidget, 19.1);
      expect(Math.sign(node("leftIndexIntermediate").rotation.z)).toBe(version === "0" ? 1 : -1);
      advance(fidget, 20.1);
      expect(Math.sign(node("rightIndexIntermediate").rotation.z)).toBe(version === "0" ? -1 : 1);
    }
  });

  it("releases an automatic handoff over 180ms without the peak-to-rest jump or another episode", () => {
    const { fidget, node } = fixture();
    advance(fidget, 19.1);
    const finger = node("leftLittleIntermediate");
    const peak = finger.quaternion.clone();
    const previous = peak.clone();
    let maxStep = 0;
    for (let frame = 0; frame < 11; frame++) {
      fidget.update(1 / 60, false, true);
      const step = finger.quaternion.angleTo(previous);
      if (frame === 0) expect(step).toBeLessThan(0.002);
      maxStep = Math.max(maxStep, step);
      previous.copy(finger.quaternion);
    }
    expect(peak.angleTo(finger.quaternion)).toBeCloseTo(0.25, 5);
    expect(maxStep).toBeLessThan(0.045);
    expect(finger.rotation.z).toBeCloseTo(0, 12);
    for (let frame = 0; frame < 500; frame++) fidget.update(0.1, false, true);
    expect(finger.rotation.z).toBeCloseTo(0, 12);
    expect(node("rightLittleIntermediate").rotation.z).toBeCloseTo(0, 12);
  });

  it("keeps departing automatic shape relative to the new source, but cleans a hard owner immediately", () => {
    const { fidget, node } = fixture();
    advance(fidget, 19.1);
    const finger = node("leftIndexIntermediate");
    for (let frame = 0; frame < 9; frame++) {
      fidget.restoreBaseRotations();
      finger.rotation.set(0.04, 0.02, -0.4 - frame * 0.01);
      const automatic = finger.quaternion.clone();
      fidget.update(0.02, false, true);
      if (frame === 0) expect(finger.quaternion.angleTo(automatic)).toBeGreaterThan(0.17);
      if (frame === 8) expect(finger.quaternion.angleTo(automatic)).toBeLessThan(1e-7);
    }
    advance(fidget, 19.1);
    fidget.update(0.02, false, true);
    fidget.restoreBaseRotations();
    finger.rotation.set(0.2, 0.1, -0.6);
    const manual = finger.quaternion.clone();
    fidget.update(1 / 60, false, false);
    expect(finger.quaternion.equals(manual)).toBe(true);
  });

  it("keeps bounded release curves when interrupted during the rise, hold or fall", () => {
    for (const episodeTime of [0.2, 0.6, 1, 1.4, 1.8]) {
      const { fidget, node } = fixture();
      advance(fidget, 18.1 + episodeTime);
      for (let frame = 0; frame < 18; frame++) {
        fidget.update(0.01, false, true);
        expect(Math.abs(node("leftLittleIntermediate").rotation.z)).toBeLessThanOrEqual(0.250001);
      }
      expect(node("leftLittleIntermediate").rotation.z).toBeCloseTo(0, 12);
    }
  });

  it("settles long frame gaps without replaying a backlog and disposes without residual curl", () => {
    const { fidget, node } = fixture();
    advance(fidget, 19.1);
    fidget.update(10, true);
    expect(node("leftIndexIntermediate").rotation.z).toBeCloseTo(0, 12);
    advance(fidget, 17.8);
    expect(node("rightIndexIntermediate").rotation.z).toBeCloseTo(0, 12);
    advance(fidget, 1.3);
    expect(node("rightIndexIntermediate").rotation.z).toBeGreaterThan(0.17);
    fidget.dispose();
    expect(node("rightIndexIntermediate").rotation.z).toBeCloseTo(0, 12);
    advance(fidget, 60);
    expect(node("rightIndexIntermediate").rotation.z).toBeCloseTo(0, 12);
  });

  it("does not start on incomplete hands and contains invalid timing/random input", () => {
    const { vrm, bones, node } = fixture("1", () => Number.NaN);
    bones.delete("leftLittleDistal");
    const fidget = new RelaxedHandFidget(vrm, { random: () => Number.NaN });
    fidget.update(Number.NaN, true);
    fidget.update(-1, true);
    advance(fidget, 60);
    expect(node("leftIndexIntermediate").rotation.z).toBeCloseTo(0, 12);
    expect(node("rightIndexIntermediate").rotation.z).toBeCloseTo(0, 12);
  });
});

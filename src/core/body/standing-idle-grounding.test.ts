import { type VRM, type VRMHumanBones, VRMHumanoid } from "@pixiv/three-vrm";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { conditionMotionLoop } from "./motion-transition";
import {
  calibrateQuietIdleUpperBodyClip,
  calibrateStandingIdleClip,
  groundStandingIdleClip,
} from "./standing-idle-grounding";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing test fixture value");
  return value;
}

function fixture() {
  const scene = new THREE.Object3D();
  const bones: Record<string, { node: THREE.Object3D }> = {};
  const add = (name: string, parent: THREE.Object3D, position: number[]) => {
    const node = new THREE.Object3D();
    node.name = name;
    node.position.fromArray(position);
    parent.add(node);
    bones[name] = { node };
    return node;
  };
  const hips = add("hips", scene, [0, 0.95, 0]);
  for (const [side, x] of [
    ["left", 0.1],
    ["right", -0.1],
  ] as const) {
    const thigh = add(`${side}UpperLeg`, hips, [x, -0.05, 0]);
    const shin = add(`${side}LowerLeg`, thigh, [0, -0.42, 0]);
    const foot = add(`${side}Foot`, shin, [0, -0.42, 0]);
    add(`${side}Toes`, foot, [0, -0.03, 0.12]);
  }
  scene.updateMatrixWorld(true);
  const humanoid = new VRMHumanoid(bones as VRMHumanBones);
  scene.add(humanoid.normalizedHumanBonesRoot);
  const vrm = { scene, humanoid } as VRM;
  const times = Array.from({ length: 121 }, (_, frame) => frame / 60);
  const tracks = Object.entries(humanoid.normalizedHumanBones).map(([name, { node }]) => {
    const axis = new THREE.Vector3(0, 0, 1);
    return new THREE.QuaternionKeyframeTrack(
      `${node.name}.quaternion`,
      times,
      times.flatMap((time) =>
        new THREE.Quaternion()
          .setFromAxisAngle(axis, name === "hips" ? 0.15 + 0.006 * Math.sin(time * Math.PI) : 0)
          .toArray(),
      ),
    );
  });
  return { vrm, original: new THREE.AnimationClip("Idle", 2, tracks) };
}

function measure(vrm: VRM, clip: THREE.AnimationClip, weight: number | "fade", phase = 0) {
  vrm.humanoid.resetNormalizedPose();
  const mixer = new THREE.AnimationMixer(vrm.scene);
  const action = mixer.clipAction(clip).play();
  const feet = ["leftFoot", "leftToes", "rightFoot", "rightToes"] as const;
  let initial: THREE.Vector3[] = [];
  let maxDrift = 0;
  let maxRawDifference = 0;
  for (let frame = 0; frame <= 480; frame++) {
    const u = Math.min(1, frame / 120 / 1.2);
    action.setEffectiveWeight(weight === "fade" ? u * u * (3 - 2 * u) : weight);
    mixer.setTime(frame / 120 + phase);
    vrm.scene.updateMatrixWorld(true);
    vrm.humanoid.update();
    vrm.scene.updateMatrixWorld(true);
    const positions = feet.map((name) =>
      required(vrm.humanoid.getNormalizedBoneNode(name)).getWorldPosition(new THREE.Vector3()),
    );
    if (frame === 0) initial = positions.map((position) => position.clone());
    for (let foot = 0; foot < positions.length; foot++) {
      maxDrift = Math.max(maxDrift, positions[foot].distanceTo(initial[foot]));
      const raw = required(vrm.humanoid.getRawBoneNode(feet[foot])).getWorldPosition(
        new THREE.Vector3(),
      );
      maxRawDifference = Math.max(maxRawDifference, positions[foot].distanceTo(raw));
    }
  }
  mixer.stopAllAction();
  return { maxDrift, maxRawDifference };
}

describe("reviewed quiet Idle upper-body calibration", () => {
  const names = ["spine", "chest", "upperChest", "head", "leftUpperArm", "rightIndexProximal"];
  const upperFixture = () => {
    const rest = new Map<string, number[]>();
    const tracks = names.map((name, index) => {
      const first = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, index * 0.03, 0.2));
      const reference = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(index * -0.02, 0.07, name === "rightIndexProximal" ? -0.25 : 0.01),
      );
      rest.set(`${name}.quaternion`, reference.toArray());
      return new THREE.QuaternionKeyframeTrack(
        `${name}.quaternion`,
        [0, 0.5, 1],
        [0, 0.04, -0.02].flatMap((angle) =>
          first
            .clone()
            .multiply(
              new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(1, 2, 3).normalize(),
                angle,
              ),
            )
            .toArray(),
        ),
      );
    });
    return { clip: new THREE.AnimationClip("quiet", 1, tracks), rest };
  };

  it("uses the entire relaxed upper chain and preserves noncommuting local motion including fingers", () => {
    const { clip, rest } = upperFixture();
    const original = clip.tracks.map((track) => [...track.values]);
    const calibrated = calibrateQuietIdleUpperBodyClip(clip, rest);
    expect(calibrated).not.toBe(clip);
    for (let bone = 0; bone < clip.tracks.length; bone++) {
      const before = clip.tracks[bone];
      const after = calibrated.tracks[bone];
      const first = new THREE.Quaternion().fromArray(before.values).normalize();
      const reference = new THREE.Quaternion()
        .fromArray(required(rest.get(before.name)))
        .normalize();
      expect(
        new THREE.Quaternion().fromArray(after.values).normalize().angleTo(reference),
      ).toBeLessThan(1e-6);
      for (let key = 0; key < before.values.length; key += 4) {
        const sourceDelta = first
          .clone()
          .invert()
          .multiply(new THREE.Quaternion().fromArray(before.values, key).normalize());
        const targetDelta = reference
          .clone()
          .invert()
          .multiply(new THREE.Quaternion().fromArray(after.values, key).normalize());
        expect(targetDelta.angleTo(sourceDelta)).toBeLessThan(1e-6);
      }
      // Left-multiplying by a constant rotation also preserves angular speed.
      const speed = (values: ArrayLike<number>) =>
        new THREE.Quaternion()
          .fromArray(values, 4)
          .normalize()
          .angleTo(new THREE.Quaternion().fromArray(values, 8).normalize()) / 0.5;
      expect(speed(after.values)).toBeCloseTo(speed(before.values), 6);
      expect([...after.times]).toEqual([...before.times]);
    }
    expect(clip.tracks.map((track) => [...track.values])).toEqual(original);
  });

  it("fails closed for unknown rest, invalid rotations or a non-quiet performance", () => {
    const { clip, rest } = upperFixture();
    expect(calibrateQuietIdleUpperBodyClip(clip, new Map())).toBe(clip);
    for (const invalid of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const bad = clip.clone();
      bad.tracks[0].values.fill(invalid, 0, 4);
      expect(calibrateQuietIdleUpperBodyClip(bad, rest)).toBe(bad);
      const invalidRest = new Map(rest).set(clip.tracks[0].name, [
        invalid,
        invalid,
        invalid,
        invalid,
      ]);
      expect(calibrateQuietIdleUpperBodyClip(clip, invalidRest)).toBe(clip);
    }
    const gesture = clip.clone();
    new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(1, 0, 0))
      .toArray(gesture.tracks[0].values, 4);
    expect(calibrateQuietIdleUpperBodyClip(gesture, rest)).toBe(gesture);
    const long = clip.clone();
    long.duration = 60;
    expect(calibrateQuietIdleUpperBodyClip(long, rest)).toBe(long);
  });
});

describe("reviewed standing Idle grounding", () => {
  it("calibrates the source stance while retaining every recorded local rotation change", () => {
    const { vrm, original } = fixture();
    const hipsRest = required(vrm.humanoid.normalizedRestPose.hips);
    hipsRest.rotation = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(0.1, -0.2, 0.05))
      .toArray();
    const hipTrackName = `${required(vrm.humanoid.getNormalizedBoneNode("hips")).name}.quaternion`;
    const originalValues = original.tracks.map((track) => [...track.values]);
    const calibrated = calibrateStandingIdleClip(original, vrm);
    expect(calibrated).not.toBe(original);
    expect(calibrated.tracks).toHaveLength(9);
    for (let bone = 0; bone < 9; bone++) {
      const source = original.tracks[bone];
      const result = calibrated.tracks[bone];
      const first = new THREE.Quaternion().fromArray(source.values).normalize();
      const reference =
        source.name === hipTrackName
          ? new THREE.Quaternion().fromArray(required(hipsRest.rotation))
          : new THREE.Quaternion();
      expect(
        new THREE.Quaternion().fromArray(result.values).normalize().angleTo(reference),
      ).toBeLessThan(1e-6);
      for (let index = 0; index < source.values.length; index += 4) {
        const delta = first
          .clone()
          .invert()
          .multiply(new THREE.Quaternion().fromArray(source.values, index).normalize());
        const actual = new THREE.Quaternion().fromArray(result.values, index).normalize();
        expect(actual.angleTo(reference.clone().multiply(delta))).toBeLessThan(1e-6);
      }
    }
    expect(original.tracks.map((track) => [...track.values])).toEqual(originalValues);
  });

  it("reduces planted-foot drift at actual mixer weights and during a fade from rest", () => {
    const { vrm, original } = fixture();
    const calibrated = calibrateStandingIdleClip(original, vrm);
    const conditioned = conditionMotionLoop(calibrated);
    const grounded = groundStandingIdleClip(conditioned, vrm);
    expect(grounded.tracks.slice(0, -1)).toEqual(conditioned.tracks);
    expect(
      grounded.tracks.slice(0, -1).every((track, index) => track === conditioned.tracks[index]),
    ).toBe(true);
    expect(measure(vrm, original, "fade").maxDrift).toBeGreaterThan(0.1);
    for (const weight of [0.2, 0.5, 1] as const) {
      const before = measure(vrm, calibrated, weight);
      const after = measure(vrm, grounded, weight);
      expect(after.maxDrift).toBeLessThan(before.maxDrift / 5);
      expect(after.maxDrift).toBeLessThan(0.001);
      expect(after.maxRawDifference).toBeLessThan(1e-8);
    }
    for (const phase of [0, 0.4, 1.2]) {
      expect(measure(vrm, grounded, "fade", phase).maxDrift).toBeLessThan(0.001);
    }
    expect(measure(vrm, grounded, 0).maxDrift).toBe(0);
  });

  it("uses stable rest transforms and never changes the live posed avatar or source clip", () => {
    const { vrm, original } = fixture();
    const expected = groundStandingIdleClip(calibrateStandingIdleClip(original, vrm), vrm);
    const hips = required(vrm.humanoid.getNormalizedBoneNode("hips"));
    hips.position.set(2, 3, 4);
    hips.rotation.set(0.8, -0.5, 1.2);
    required(vrm.humanoid.getNormalizedBoneNode("leftUpperLeg")).rotation.set(-0.9, 0.3, 0.6);
    vrm.scene.position.set(-3, 8, 4);
    vrm.scene.rotation.set(0.2, 0.7, -0.3);
    vrm.scene.scale.setScalar(1.7);
    vrm.humanoid.normalizedHumanBonesRoot.rotation.set(0.3, -0.6, 0.1);
    vrm.humanoid.normalizedHumanBonesRoot.scale.setScalar(1.4);
    vrm.scene.updateMatrixWorld(true);
    const snapshot = () => {
      const values: number[] = [];
      vrm.scene.traverse((node) =>
        values.push(
          ...node.position,
          ...node.quaternion,
          ...node.scale,
          ...node.matrix.elements,
          ...node.matrixWorld.elements,
        ),
      );
      return values;
    };
    const before = snapshot();
    const actual = groundStandingIdleClip(calibrateStandingIdleClip(original, vrm), vrm);
    for (let track = 0; track < actual.tracks.length; track++) {
      for (let key = 0; key < actual.tracks[track].values.length; key++) {
        expect(actual.tracks[track].values[key]).toBeCloseTo(expected.tracks[track].values[key], 8);
      }
    }
    expect(snapshot()).toEqual(before);
  });

  it("bounds sample work, closes the position seam, and rejects missing or invalid inputs", () => {
    const { vrm, original } = fixture();
    const grounded = groundStandingIdleClip(calibrateStandingIdleClip(original, vrm), vrm);
    const position = required(grounded.tracks[grounded.tracks.length - 1]);
    expect(position.times).toHaveLength(121);
    expect(position.values.slice(-3)).toEqual(position.values.slice(0, 3));
    const huge = original.clone();
    huge.duration = 1_000_000;
    const malformed = original.clone();
    malformed.tracks[0].values[0] = NaN;
    const zeroQuaternion = original.clone();
    zeroQuaternion.tracks[0].values.fill(0, 0, 4);
    const nonQuiet = original.clone();
    new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1)
      .toArray(nonQuiet.tracks[0].values, 4);
    for (const bad of [huge, malformed, zeroQuaternion]) {
      expect(calibrateStandingIdleClip(bad, vrm)).toBe(bad);
      expect(groundStandingIdleClip(bad, vrm)).toBe(bad);
    }
    expect(calibrateStandingIdleClip(nonQuiet, vrm)).toBe(nonQuiet);
    const incomplete = { humanoid: { getNormalizedBoneNode: () => null } } as unknown as VRM;
    expect(calibrateStandingIdleClip(original, incomplete)).toBe(original);
    expect(groundStandingIdleClip(original, incomplete)).toBe(original);
    // Repeated preparation cannot accumulate position curves.
    expect(groundStandingIdleClip(grounded, vrm)).toBe(grounded);
  });
});

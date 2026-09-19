import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  FootContactController,
  type FootContactProfile,
  isFootContactProfileValid,
} from "./foot-contact";

const profile: FootContactProfile = {
  sourceSha256: "a".repeat(64),
  durationSec: 8,
  left: [[0, 8]],
  right: [
    [0, 2],
    [4, 8],
  ],
};

function rig(scale = 1) {
  const scene = new THREE.Object3D();
  scene.scale.setScalar(scale);
  const bones = new Map<string, THREE.Object3D>();
  const add = (name: string, parent: THREE.Object3D, x: number, y: number, z: number) => {
    const node = new THREE.Object3D();
    node.name = name;
    node.position.set(x, y, z);
    parent.add(node);
    bones.set(name, node);
    return node;
  };
  const hips = add("hips", scene, 0, 0.9, 0);
  for (const side of ["left", "right"]) {
    const upper = add(`${side}UpperLeg`, hips, side === "left" ? 0.08 : -0.08, -0.03, 0);
    const lower = add(`${side}LowerLeg`, upper, 0, -0.4, 0);
    const foot = add(`${side}Foot`, lower, 0, -0.4, 0);
    add(`${side}Toes`, foot, 0, -0.03, 0.1);
    upper.rotation.x = 0.15;
    lower.rotation.x = -0.3;
    foot.rotation.x = 0.15;
  }
  const vrm = {
    scene,
    humanoid: { getNormalizedBoneNode: (name: VRMHumanBoneName) => bones.get(name) },
  } as unknown as VRM;
  const controller = new FootContactController(vrm);
  const bone = (name: string) => {
    const result = bones.get(name);
    if (!result) throw new Error(name);
    return result;
  };
  const center = (side: string) =>
    bone(`${side}Foot`)
      .getWorldPosition(new THREE.Vector3())
      .add(bone(`${side}Toes`).getWorldPosition(new THREE.Vector3()))
      .multiplyScalar(0.5);
  return { vrm, scene, hips, bone, controller, center };
}

describe("runtime contact IK", () => {
  it.each([
    1, 2,
  ])("locks a supported foot at scale %s while preserving ankle orientation and restoring mixer inputs", (scale) => {
    const { controller, hips, scene, bone, center } = rig(scale);
    let anchor: THREE.Vector3 | undefined;
    for (let frame = 0; frame < 90; frame++) {
      controller.restore();
      hips.position.set(0.01 * Math.sin(frame / 20), 0.9 + 0.004 * Math.sin(frame / 13), 0);
      scene.updateMatrixWorld(true);
      const originalHips = hips.position.clone();
      const rotations = ["UpperLeg", "LowerLeg", "Foot"].map((part) =>
        bone(`left${part}`).quaternion.clone(),
      );
      const footOrientation = bone("leftFoot").getWorldQuaternion(new THREE.Quaternion());
      controller.update(1 / 60, { id: 1, phaseSec: 0.6 + frame / 60, strength: 1, profile });
      scene.updateMatrixWorld(true);
      expect(controller.getSnapshot().rejected).toBeNull();
      expect(
        bone("leftFoot").getWorldQuaternion(new THREE.Quaternion()).angleTo(footOrientation),
      ).toBeLessThan(1e-6);
      if (frame === 25) anchor = center("left");
      if (frame > 25) expect(center("left").distanceTo(anchor as THREE.Vector3)).toBeLessThan(1e-6);
      controller.restore();
      expect(hips.position.toArray()).toEqual(originalHips.toArray());
      ["UpperLeg", "LowerLeg", "Foot"].forEach((part, i) => {
        expect(bone(`left${part}`).quaternion.toArray()).toEqual(rotations[i].toArray());
      });
    }
  });

  it("releases only the unsupported leg, retaining authored lift rotations", () => {
    const { controller, hips, scene, bone } = rig();
    for (let frame = 0; frame < 90; frame++) {
      controller.restore();
      const phaseSec = 1 + frame / 60;
      hips.position.x = 0.005 * Math.sin(frame / 15);
      bone("rightUpperLeg").rotation.x = phaseSec > 2 ? 0.35 : 0.15;
      const source = ["UpperLeg", "LowerLeg", "Foot"].map((part) =>
        bone(`right${part}`).quaternion.clone(),
      );
      scene.updateMatrixWorld(true);
      controller.update(1 / 60, { id: 1, phaseSec, strength: 1, profile });
      if (phaseSec > 2) {
        expect(controller.getSnapshot().rightWeight).toBe(0);
        expect(controller.getSnapshot().leftWeight).toBe(1);
        ["UpperLeg", "LowerLeg", "Foot"].forEach((part, i) => {
          expect(bone(`right${part}`).quaternion.toArray()).toEqual(source[i].toArray());
        });
      }
    }
  });

  it("does not lock a new stance during its entry fade, and clears on lost ownership", () => {
    const { controller, hips } = rig();
    hips.position.y += 0.01;
    for (let i = 0; i < 20; i++)
      controller.update(1 / 60, { id: 1, phaseSec: 1, strength: 0.5, profile });
    expect(controller.getSnapshot().active).toBe(false);
    for (let i = 0; i < 30; i++) {
      controller.restore();
      controller.update(1 / 60, { id: 1, phaseSec: 1, strength: 1, profile });
    }
    expect(controller.getSnapshot().active).toBe(true);
    controller.update(1 / 60, null);
    expect(controller.getSnapshot().active).toBe(false);
    expect(hips.position.y).toBeCloseTo(0.91);
  });

  it("fails closed for nonuniform scale and unreliable frame timing", () => {
    const { scene, controller } = rig();
    scene.scale.set(1, 2, 1);
    controller.update(1 / 60, { id: 1, phaseSec: 1, strength: 1, profile });
    expect(controller.getSnapshot()).toMatchObject({
      active: false,
      rejected: "unsupported-scale",
    });
    controller.update(0.2, { id: 1, phaseSec: 1, strength: 1, profile });
    expect(controller.getSnapshot()).toMatchObject({ active: false, rejected: "unreliable-frame" });
  });

  it("holds the paused solve and reacquires after an owner or root transform change", () => {
    const { scene, controller, hips, center } = rig();
    hips.position.y += 0.01;
    for (let i = 0; i < 30; i++) {
      controller.restore();
      controller.update(1 / 60, { id: 1, phaseSec: 1, strength: 1, profile });
    }
    const held = center("left");
    for (let i = 0; i < 30; i++) {
      controller.restore();
      controller.update(0, { id: 1, phaseSec: 1, strength: 1, profile });
      expect(center("left").distanceTo(held)).toBeLessThan(1e-6);
    }
    controller.restore();
    controller.update(1 / 60, { id: 2, phaseSec: 1, strength: 1, profile });
    expect(controller.getSnapshot().leftWeight).toBe(0);
    for (let i = 0; i < 30; i++) {
      controller.restore();
      controller.update(1 / 60, { id: 2, phaseSec: 1, strength: 1, profile });
    }
    controller.restore();
    scene.position.x += 1;
    scene.scale.setScalar(2);
    controller.update(1 / 60, { id: 2, phaseSec: 1, strength: 1, profile });
    expect(controller.getSnapshot()).toMatchObject({ leftWeight: 0, rejected: null });
    expect(hips.position.y).toBeCloseTo(0.91);
  });

  it("rejects ambiguous, short, overlapping or out-of-range contact annotations", () => {
    expect(isFootContactProfileValid(profile)).toBe(true);
    for (const left of [
      [[0, 1]],
      [
        [0, 4],
        [3, 7],
      ],
      [[-1, 4]],
      [[1, 9]],
      [[NaN, 4]],
    ])
      expect(isFootContactProfileValid({ ...profile, left: left as [number, number][] })).toBe(
        false,
      );
  });
});

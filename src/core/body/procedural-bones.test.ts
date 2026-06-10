/**
 * ProceduralBones — bone 直接操作層のテスト。
 *
 * 実 VRM なしで normalized bone stub に対する書き込みを検証する
 * （mockVrm パターンは vrm-rest-pose.test.ts と同じ）。
 */

import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ProceduralBones } from "./procedural-bones";

function mockVrm(): {
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
  const vrm = {
    meta: { metaVersion: "1" },
    humanoid: {
      resetNormalizedPose: () => {},
      getNormalizedBoneNode: getBone,
    },
  } as unknown as VRM;
  return { vrm, getBone };
}

const DT = 1 / 60;

describe("ProceduralBones breathing offsets", () => {
  it("chestPitch が spine.rotation.x に weight 込みで加算される", () => {
    const { vrm, getBone } = mockVrm();
    const bones = new ProceduralBones(() => 0.5);
    bones.bindVrm(vrm);

    bones.update(DT, 1.0, 1.0);
    const withoutBreath = getBone("spine").rotation.x;

    bones.setBreathingOffsets(0.02, 0);
    bones.update(DT, 1.0, 1.0);
    expect(getBone("spine").rotation.x).toBeCloseTo(withoutBreath + 0.02, 5);
  });

  it("shoulderLift が左右の upperArm.rotation.z にミラーで加算される", () => {
    const { vrm, getBone } = mockVrm();
    const bones = new ProceduralBones(() => 0.5);
    bones.bindVrm(vrm);

    bones.update(DT, 1.0, 1.0);
    const leftBase = getBone("leftUpperArm").rotation.z;
    const rightBase = getBone("rightUpperArm").rotation.z;

    bones.setBreathingOffsets(0, 0.01);
    bones.update(DT, 1.0, 1.0);
    const leftDiff = getBone("leftUpperArm").rotation.z - leftBase;
    const rightDiff = getBone("rightUpperArm").rotation.z - rightBase;
    expect(Math.abs(leftDiff)).toBeCloseTo(0.01, 5);
    expect(Math.abs(rightDiff)).toBeCloseTo(0.01, 5);
    // 左右でミラー（符号が逆）
    expect(leftDiff).toBeCloseTo(-rightDiff, 5);
  });

  it("weight 0 では breathing offset も適用されない", () => {
    const { vrm, getBone } = mockVrm();
    const bones = new ProceduralBones(() => 0.5);
    bones.bindVrm(vrm);

    bones.setBreathingOffsets(0.02, 0.01);
    bones.update(DT, 1.0, 0.0);
    // weight 0 では spine sway 自体が書かれない（rotation は触られない）
    expect(getBone("spine").rotation.x).toBe(0);
  });
});

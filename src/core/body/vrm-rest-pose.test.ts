import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { applyVrmRestPose, createVrmRestPose } from "./vrm-rest-pose";

describe("createVrmRestPose", () => {
  it("keeps existing arm signs for VRM 0.x models", () => {
    const pose = createVrmRestPose(mockVrm("0").vrm);

    expect(pose.leftArm.upperArmZ).toBe(1.35);
    expect(pose.rightArm.upperArmZ).toBe(-1.35);
    expect(pose.leftArm.lowerArmZ).toBe(0.2);
    expect(pose.rightArm.lowerArmZ).toBe(-0.2);
  });

  it("inverts arm signs for VRM 1.0 models", () => {
    const pose = createVrmRestPose(mockVrm("1").vrm);

    expect(pose.leftArm.upperArmZ).toBe(-1.35);
    expect(pose.rightArm.upperArmZ).toBe(1.35);
    expect(pose.leftArm.lowerArmZ).toBe(-0.2);
    expect(pose.rightArm.lowerArmZ).toBe(0.2);
  });
});

describe("applyVrmRestPose", () => {
  it("writes the VRM 0.x rest pose to normalized bones", () => {
    const { vrm, getBone, getResetCount } = mockVrm("0");

    applyVrmRestPose(vrm);

    expect(getResetCount()).toBe(1);
    expect(getBone("leftUpperArm").rotation.z).toBe(1.35);
    expect(getBone("rightUpperArm").rotation.z).toBe(-1.35);
    expect(getBone("leftHand").rotation.z).toBe(0.2);
    expect(getBone("rightHand").rotation.z).toBe(-0.2);
    expect(getBone("leftThumbMetacarpal").rotation.z).toBe(0.3);
    expect(getBone("rightThumbMetacarpal").rotation.z).toBe(-0.3);
    expect(getBone("leftIndexProximal").rotation.x).toBe(0.25);
  });

  it("writes the VRM 1.0 rest pose to normalized bones", () => {
    const { vrm, getBone, getResetCount } = mockVrm("1");

    applyVrmRestPose(vrm);

    expect(getResetCount()).toBe(1);
    expect(getBone("leftUpperArm").rotation.z).toBe(-1.35);
    expect(getBone("rightUpperArm").rotation.z).toBe(1.35);
    expect(getBone("leftHand").rotation.z).toBe(-0.2);
    expect(getBone("rightHand").rotation.z).toBe(0.2);
    expect(getBone("leftThumbMetacarpal").rotation.z).toBe(-0.3);
    expect(getBone("rightThumbMetacarpal").rotation.z).toBe(0.3);
    expect(getBone("rightIndexProximal").rotation.x).toBe(0.25);
  });
});

function mockVrm(metaVersion: "0" | "1"): {
  readonly vrm: VRM;
  readonly getBone: (name: VRMHumanBoneName) => THREE.Object3D;
  readonly getResetCount: () => number;
} {
  const bones = new Map<VRMHumanBoneName, THREE.Object3D>();
  let resetCount = 0;

  const getBone = (name: VRMHumanBoneName): THREE.Object3D => {
    let bone = bones.get(name);
    if (!bone) {
      bone = new THREE.Object3D();
      bones.set(name, bone);
    }
    return bone;
  };

  const vrm = {
    meta: { metaVersion },
    humanoid: {
      resetNormalizedPose: () => {
        resetCount += 1;
      },
      getNormalizedBoneNode: getBone,
    },
  } as unknown as VRM;

  return { vrm, getBone, getResetCount: () => resetCount };
}

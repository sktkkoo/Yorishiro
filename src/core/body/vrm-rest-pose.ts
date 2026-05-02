import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";

const UPPER_ARM_Z = 1.35;
const UPPER_ARM_X = 0.1;
const LOWER_ARM_Z = 0.2;
const HAND_Z = 0.2;
const THUMB_METACARPAL_X = 0.2;
const THUMB_METACARPAL_Z = 0.3;
const THUMB_PROXIMAL_X = 0.15;
const THUMB_DISTAL_X = 0.1;

export interface VrmArmRestPose {
  readonly upperArmZ: number;
  readonly upperArmX: number;
  readonly lowerArmZ: number;
  readonly handZ: number;
  readonly thumbMetacarpalX: number;
  readonly thumbMetacarpalZ: number;
  readonly thumbProximalX: number;
  readonly thumbDistalX: number;
}

export interface VrmRestPose {
  readonly leftArm: VrmArmRestPose;
  readonly rightArm: VrmArmRestPose;
}

const fingerCurl: ReadonlyArray<[string, number]> = [
  ["IndexProximal", 0.25],
  ["IndexIntermediate", 0.35],
  ["IndexDistal", 0.2],
  ["MiddleProximal", 0.3],
  ["MiddleIntermediate", 0.4],
  ["MiddleDistal", 0.25],
  ["RingProximal", 0.35],
  ["RingIntermediate", 0.45],
  ["RingDistal", 0.25],
  ["LittleProximal", 0.4],
  ["LittleIntermediate", 0.5],
  ["LittleDistal", 0.3],
];

export function createVrmRestPose(vrm: Pick<VRM, "meta">): VrmRestPose {
  const leftZSign: 1 | -1 = isVrm1(vrm) ? -1 : 1;
  const rightZSign: 1 | -1 = leftZSign === 1 ? -1 : 1;

  return {
    leftArm: createArmRestPose(leftZSign),
    rightArm: createArmRestPose(rightZSign),
  };
}

export function applyVrmRestPose(vrm: VRM): VrmRestPose | null {
  const humanoid = vrm.humanoid;
  if (!humanoid) return null;

  humanoid.resetNormalizedPose();

  const restPose = createVrmRestPose(vrm);
  const set = (name: VRMHumanBoneName, axis: "x" | "y" | "z", rad: number) => {
    const bone = humanoid.getNormalizedBoneNode(name);
    if (bone) bone.rotation[axis] = rad;
  };

  set("leftUpperArm", "z", restPose.leftArm.upperArmZ);
  set("rightUpperArm", "z", restPose.rightArm.upperArmZ);
  set("leftUpperArm", "x", restPose.leftArm.upperArmX);
  set("rightUpperArm", "x", restPose.rightArm.upperArmX);

  set("leftLowerArm", "z", restPose.leftArm.lowerArmZ);
  set("rightLowerArm", "z", restPose.rightArm.lowerArmZ);

  set("leftHand", "z", restPose.leftArm.handZ);
  set("rightHand", "z", restPose.rightArm.handZ);

  for (const [suffix, angle] of fingerCurl) {
    set(`left${suffix}` as VRMHumanBoneName, "x", angle);
    set(`right${suffix}` as VRMHumanBoneName, "x", angle);
  }

  applyThumbRestPose("left", restPose.leftArm, set);
  applyThumbRestPose("right", restPose.rightArm, set);

  return restPose;
}

function createArmRestPose(zSign: 1 | -1): VrmArmRestPose {
  return {
    upperArmZ: zSign * UPPER_ARM_Z,
    upperArmX: UPPER_ARM_X,
    lowerArmZ: zSign * LOWER_ARM_Z,
    handZ: zSign * HAND_Z,
    thumbMetacarpalX: THUMB_METACARPAL_X,
    thumbMetacarpalZ: zSign * THUMB_METACARPAL_Z,
    thumbProximalX: THUMB_PROXIMAL_X,
    thumbDistalX: THUMB_DISTAL_X,
  };
}

function applyThumbRestPose(
  side: "left" | "right",
  pose: VrmArmRestPose,
  set: (name: VRMHumanBoneName, axis: "x" | "y" | "z", rad: number) => void,
): void {
  set(`${side}ThumbMetacarpal` as VRMHumanBoneName, "x", pose.thumbMetacarpalX);
  set(`${side}ThumbMetacarpal` as VRMHumanBoneName, "z", pose.thumbMetacarpalZ);
  set(`${side}ThumbProximal` as VRMHumanBoneName, "x", pose.thumbProximalX);
  set(`${side}ThumbDistal` as VRMHumanBoneName, "x", pose.thumbDistalX);
}

function isVrm1(vrm: Pick<VRM, "meta">): boolean {
  return vrm.meta.metaVersion === "1";
}

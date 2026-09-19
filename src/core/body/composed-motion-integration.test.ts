import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { ClaimState } from "../../runtime/ui-claim-state";
import { Body } from "./index";

describe("Body final-pose monitoring", () => {
  it("samples the normalized pose after VRM update and exposes a bounded opt-in trace", () => {
    const scene = new THREE.Object3D();
    const bones = new Map<VRMHumanBoneName, THREE.Object3D>();
    const bone = (name: VRMHumanBoneName) => {
      let node = bones.get(name);
      if (!node) {
        node = new THREE.Object3D();
        node.name = name;
        bones.set(name, node);
        scene.add(node);
      }
      return node;
    };
    let finalHeadAngle = 0;
    const vrm = {
      meta: { metaVersion: "1" },
      scene,
      humanoid: { resetNormalizedPose: () => {}, getNormalizedBoneNode: bone },
      expressionManager: { getExpression: () => null, setValue: () => {}, update: () => {} },
      lookAt: { yaw: 0, pitch: 0, applier: { applyYawPitch: () => {} } },
      update: () => {
        bone("head").rotation.z = finalHeadAngle;
      },
    } as unknown as VRM;
    // An external owner lets the final VRM callback supply a deterministic pose.
    const claims: ClaimState = {
      isClaimed: () => true,
      claim: () => ({ dispose: () => {} }),
      releaseAll: () => {},
    };
    const body = new Body(vrm, undefined, claims);
    try {
      for (let frame = 0; frame < 3; frame++) body.update(1 / 60, frame / 60);
      finalHeadAngle = 0.3;
      body.update(1 / 60, 3 / 60);
      const snapshot = body.getComposedMotionSnapshot(true);
      const headIndex = snapshot.bones.indexOf("head");
      const last = snapshot.frames?.[snapshot.frames.length - 1];
      expect(last?.pose.slice(headIndex * 7, headIndex * 7 + 4)).toEqual(
        Array.from(new Float32Array(bone("head").quaternion.toArray())),
      );
      expect(snapshot.poseCandidateCount).toBe(1);
      expect(snapshot.events[0].context.animationClaimed).toBe(true);
      expect(body.getRecordedBodySnapshot().composedMotion.poseCandidateCount).toBe(1);
      expect(body.getRecordedBodySnapshot().composedMotion.frames).toBeUndefined();
    } finally {
      body.dispose();
    }
  });
});

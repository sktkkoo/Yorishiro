import { describe, expect, it } from "vitest";
import { createSimulator, type SkeletonDefinition } from "../src";

describe("createSimulator", () => {
  it("骨格と同数の単位回転を返す", () => {
    const skeleton: SkeletonDefinition = {
      joints: [
        {
          id: "root",
          parentIndex: -1,
          restPosition: { x: 0, y: 0, z: 0 },
          restRotation: { x: 0, y: 0, z: 0, w: 1 },
        },
      ],
    };

    expect(
      createSimulator(skeleton).step({ rotations: [skeleton.joints[0].restRotation] }, 1 / 60),
    ).toEqual({ rotationDeltas: [{ x: 0, y: 0, z: 0, w: 1 }] });
  });
});

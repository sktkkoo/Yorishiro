import type { VRM } from "@pixiv/three-vrm";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import type {
  BodyResponseSimulator,
  CorrectionPose,
  ForceEvent,
  Pose,
  SkeletonDefinition,
} from "yoromeki";
import { StaggerAdapter, worldToModelForceEvent } from "./stagger-adapter";

function makeVrm(names: ReadonlyArray<string> = ["hips", "spine", "chest", "head"]): VRM {
  const scene = new THREE.Group();
  const nodes = new Map<string, THREE.Object3D>();
  for (const [index, name] of names.entries()) {
    const node = new THREE.Object3D();
    node.position.set(0, index === 0 ? 0.8 : 0.25, 0);
    nodes.set(name, node);
  }
  return {
    scene,
    humanoid: {
      getNormalizedBoneNode: (name: string) => nodes.get(name) ?? null,
    },
  } as unknown as VRM;
}

function makeSimulator(delta: THREE.Quaternion) {
  const step = vi.fn(
    (_pose: Pose, _dt: number): CorrectionPose => ({
      rotationDeltas: Array.from({ length: 6 }, () => ({
        x: delta.x,
        y: delta.y,
        z: delta.z,
        w: delta.w,
      })),
    }),
  );
  const simulator: BodyResponseSimulator = {
    applyImpulse: vi.fn((_event: ForceEvent) => undefined),
    step,
    setParams: vi.fn(),
    reset: vi.fn(),
  };
  return { simulator, step };
}

describe("StaggerAdapter", () => {
  it("restores the previous target, resamples, and applies target * delta once", () => {
    const vrm = makeVrm(["hips"]);
    const hips = vrm.humanoid?.getNormalizedBoneNode("hips");
    expect(hips).not.toBeNull();
    const correction = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.2);
    const { simulator, step } = makeSimulator(correction);
    const createSimulator = vi.fn((_skeleton: SkeletonDefinition) => simulator);
    const adapter = new StaggerAdapter(vrm, { createSimulator });

    const firstTarget = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.3);
    hips?.quaternion.copy(firstTarget);
    adapter.applyAfterAnimation(1 / 60, false);
    expect(hips?.quaternion.angleTo(firstTarget.clone().multiply(correction))).toBeLessThan(1e-8);

    adapter.restoreTargetPose();
    expect(hips?.quaternion.angleTo(firstTarget)).toBeLessThan(1e-7);
    const secondTarget = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.4);
    hips?.quaternion.copy(secondTarget);
    adapter.applyAfterAnimation(1 / 60, false);

    expect(step).toHaveBeenCalledTimes(2);
    expect(step.mock.calls[1]?.[0].rotations[0]).toMatchObject({
      x: secondTarget.x,
      y: secondTarget.y,
      z: secondTarget.z,
      w: secondTarget.w,
    });
    expect(hips?.quaternion.angleTo(secondTarget.clone().multiply(correction))).toBeLessThan(1e-8);
  });

  it("suspends and resets simulation while animation is claimed", () => {
    const vrm = makeVrm(["hips"]);
    const { simulator, step } = makeSimulator(new THREE.Quaternion());
    const adapter = new StaggerAdapter(vrm, { createSimulator: () => simulator });

    adapter.applyAfterAnimation(1 / 60, true);

    expect(simulator.reset).toHaveBeenCalledOnce();
    expect(step).not.toHaveBeenCalled();
  });

  it("reset restores the target and rebuilds the mapping and simulator", () => {
    const vrm = makeVrm(["hips", "head"]);
    const hips = vrm.humanoid?.getNormalizedBoneNode("hips");
    const correction = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.2);
    const first = makeSimulator(correction);
    const second = makeSimulator(new THREE.Quaternion());
    const createSimulator = vi
      .fn((_skeleton: SkeletonDefinition) => first.simulator)
      .mockImplementationOnce((_skeleton) => first.simulator)
      .mockImplementationOnce((_skeleton) => second.simulator);
    const adapter = new StaggerAdapter(vrm, { createSimulator });
    const target = hips?.quaternion.clone() ?? new THREE.Quaternion();
    adapter.applyAfterAnimation(1 / 60, false);

    adapter.reset();

    expect(hips?.quaternion.angleTo(target)).toBeLessThan(1e-8);
    expect(first.simulator.reset).toHaveBeenCalledOnce();
    expect(createSimulator).toHaveBeenCalledTimes(2);
    expect(createSimulator.mock.calls[1]?.[0].joints.map((joint) => joint.id)).toEqual([
      "hips",
      "head",
    ]);
  });
});

it("converts world points and directions into model space", () => {
  const root = new THREE.Object3D();
  root.position.set(2, 0, 0);
  root.rotation.y = Math.PI / 2;
  const converted = worldToModelForceEvent(
    { point: { x: 2, y: 1, z: -1 }, direction: { x: 1, y: 0, z: 0 }, magnitude: 2 },
    root,
  );
  expect(converted.point?.x).toBeCloseTo(1);
  expect(converted.point?.y).toBeCloseTo(1);
  expect(converted.point?.z).toBeCloseTo(0);
  expect(converted.direction.x).toBeCloseTo(0);
  expect(converted.direction.z).toBeCloseTo(1);
});

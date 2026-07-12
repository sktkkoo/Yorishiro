import { describe, expect, it } from "vitest";
import { createSimulator, type ForceEvent, type Quat, type SkeletonDefinition } from "../src";

const skeleton: SkeletonDefinition = {
  joints: [
    {
      id: "root",
      parentIndex: -1,
      restPosition: { x: 0, y: 0, z: 0 },
      restRotation: { x: 0, y: 0, z: 0, w: 1 },
    },
    {
      id: "child",
      parentIndex: 0,
      restPosition: { x: 0, y: 1, z: 0 },
      restRotation: { x: 0, y: 0, z: 0, w: 1 },
      responseWeight: 0,
    },
  ],
};
const pose = { rotations: skeleton.joints.map((joint) => joint.restRotation) };
const impulse = (x: number): ForceEvent => ({
  point: { x: 0, y: 1, z: 0 },
  direction: { x, y: 0, z: 0 },
  magnitude: 4,
});
const angle = (quat: Quat) => 2 * Math.acos(Math.min(1, Math.abs(quat.w)));

function run(frames: number, dt: number, event = impulse(1)) {
  const simulator = createSimulator(skeleton);
  simulator.applyImpulse(event);
  let result = simulator.step(pose, dt);
  for (let frame = 1; frame < frames; frame += 1) result = simulator.step(pose, dt);
  return result;
}

describe("SpringBackend", () => {
  it("無入力では単位回転を保つ", () => {
    expect(createSimulator(skeleton).step(pose, 1 / 60).rotationDeltas).toEqual([
      { x: 0, y: 0, z: 0, w: 1 },
      { x: 0, y: 0, z: 0, w: 1 },
    ]);
  });

  it("反対方向の外力は対称な補正を作る", () => {
    const positive = run(1, 1 / 60).rotationDeltas[0];
    const negative = run(1, 1 / 60, impulse(-1)).rotationDeltas[0];
    expect(positive.z).toBeCloseTo(-negative.z, 8);
    expect(positive.w).toBeCloseTo(negative.w, 8);
  });

  it("energy が時間とともに減衰する", () => {
    const early = angle(run(10, 1 / 60).rotationDeltas[0]);
    const late = angle(run(300, 1 / 60).rotationDeltas[0]);
    expect(early).toBeGreaterThan(late * 10);
  });

  it("joint limit を超えない", () => {
    const limited = {
      ...skeleton,
      joints: skeleton.joints.map((joint, index) =>
        index === 0 ? { ...joint, maxAngleRad: 0.05 } : joint,
      ),
    };
    const simulator = createSimulator(limited);
    simulator.applyImpulse({ ...impulse(1), magnitude: 1e6 });
    expect(angle(simulator.step(pose, 1 / 30).rotationDeltas[0])).toBeLessThanOrEqual(0.0500001);
  });

  it("子の応答は親より遅れる", () => {
    const simulator = createSimulator(skeleton, { propagationDelay: 0.05 });
    simulator.applyImpulse(impulse(1));
    const first = simulator.step(pose, 1 / 60).rotationDeltas;
    expect(angle(first[0])).toBeGreaterThan(0);
    expect(angle(first[1])).toBe(0);
    let later = first;
    for (let index = 0; index < 12; index += 1) later = simulator.step(pose, 1 / 60).rotationDeltas;
    expect(angle(later[1])).toBeGreaterThan(0);
  });

  it("同じ実時間なら frame rate 差が小さい", () => {
    const fine = run(120, 1 / 120).rotationDeltas[0];
    const coarse = run(30, 1 / 30).rotationDeltas[0];
    expect(angle(fine)).toBeCloseTo(angle(coarse), 7);
  });

  it("複数 force を線形合成する", () => {
    const simulator = createSimulator(skeleton);
    simulator.applyImpulse(impulse(1));
    simulator.applyImpulse(impulse(-1));
    expect(angle(simulator.step(pose, 1 / 60).rotationDeltas[0])).toBe(0);
  });

  it("NaN、ゼロ方向、巨大 dt を安全に扱う", () => {
    const simulator = createSimulator(skeleton);
    simulator.applyImpulse({ direction: { x: Number.NaN, y: 0, z: 0 }, magnitude: 1 });
    simulator.applyImpulse({ direction: { x: 0, y: 0, z: 0 }, magnitude: 1 });
    simulator.applyImpulse(impulse(1));
    const result = simulator.step(pose, Number.POSITIVE_INFINITY);
    expect(result.rotationDeltas.every((quat) => Object.values(quat).every(Number.isFinite))).toBe(
      true,
    );
    expect(result.rotationDeltas[0]).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });
});

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

/** 決定的な疑似乱数（mulberry32）。 */
function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
    const base = mockVrm();
    const withBreath = mockVrm();
    const baseBones = new ProceduralBones(() => 0.5);
    const breathBones = new ProceduralBones(() => 0.5);
    baseBones.bindVrm(base.vrm);
    breathBones.bindVrm(withBreath.vrm);

    baseBones.update(DT, 1.0, 1.0);
    breathBones.setBreathingOffsets(0.02, 0);
    breathBones.update(DT, 1.0, 1.0);

    expect(withBreath.getBone("spine").rotation.x - base.getBone("spine").rotation.x).toBeCloseTo(
      0.02,
      5,
    );
  });

  it("shoulderLift が左右の upperArm.rotation.z にミラーで加算される", () => {
    const base = mockVrm();
    const withBreath = mockVrm();
    const baseBones = new ProceduralBones(() => 0.5);
    const breathBones = new ProceduralBones(() => 0.5);
    baseBones.bindVrm(base.vrm);
    breathBones.bindVrm(withBreath.vrm);

    baseBones.update(DT, 1.0, 1.0);
    breathBones.setBreathingOffsets(0, 0.01);
    breathBones.update(DT, 1.0, 1.0);

    const leftDiff =
      withBreath.getBone("leftUpperArm").rotation.z - base.getBone("leftUpperArm").rotation.z;
    const rightDiff =
      withBreath.getBone("rightUpperArm").rotation.z - base.getBone("rightUpperArm").rotation.z;
    expect(Math.abs(leftDiff)).toBeCloseTo(0.01, 5);
    expect(Math.abs(rightDiff)).toBeCloseTo(0.01, 5);
    // 左右でミラー（符号が逆）
    expect(leftDiff).toBeCloseTo(-rightDiff, 5);
  });

  it("nudgeHeadToward で頭が指定方向に spring で向かう（eye-head coordination）", () => {
    const { vrm, getBone } = mockVrm();
    const bones = new ProceduralBones(() => 0.5);
    bones.bindVrm(vrm);

    bones.nudgeHeadToward(0.08);
    for (let t = 0; t < 1; t += DT) bones.update(DT, t, 1.0);
    // 即時ジャンプではなく spring で接近する（1 秒で目標の 5 割以上、微小 overshoot は許容）
    const y = getBone("head").rotation.y;
    expect(y).toBeGreaterThan(0.04);
    expect(y).toBeLessThan(0.1);
  });

  it("nudgeHeadToward は head drift の振幅域に clamp される", () => {
    const { vrm, getBone } = mockVrm();
    const bones = new ProceduralBones(() => 0.5);
    bones.bindVrm(vrm);

    bones.nudgeHeadToward(0.5);
    for (let t = 0; t < 3; t += DT) bones.update(DT, t, 1.0);
    expect(getBone("head").rotation.y).toBeLessThan(0.12);
  });

  it("spine sway は単一周期の繰り返しにならない（organic noise 化）", () => {
    const { vrm, getBone } = mockVrm();
    // rng=0.5: head drift / posture のターゲットが常に 0 → spine z は sway 成分のみ
    const bones = new ProceduralBones(() => 0.5);
    bones.bindVrm(vrm);

    // 旧実装 sin(elapsed * 0.6) の周期（2π/0.6）ぶん先と比較する
    const period = (Math.PI * 2) / 0.6;
    const samples: number[] = [];
    for (let t = 0; t < period * 2 + 5; t += DT) {
      bones.update(DT, t, 1.0);
      samples.push(getBone("spine").rotation.z);
    }
    const periodSteps = Math.round(period / DT);
    let maxDiff = 0;
    for (let i = 120; i + periodSteps < samples.length; i += 30) {
      maxDiff = Math.max(maxDiff, Math.abs(samples[i] - samples[i + periodSteps]));
    }
    expect(maxDiff).toBeGreaterThan(0.002);
  });

  it("posture shift: 時間とともに重心（spine lean）の中心がゆっくり移る", () => {
    const { vrm, getBone } = mockVrm();
    const bones = new ProceduralBones(() => 0.99);
    bones.bindVrm(vrm);

    const meanOver = (fromS: number, toS: number, clock: { t: number }): number => {
      let sum = 0;
      let n = 0;
      while (clock.t < toS) {
        bones.update(DT, clock.t, 1.0);
        if (clock.t >= fromS) {
          sum += getBone("spine").rotation.z;
          n++;
        }
        clock.t += DT;
      }
      return sum / n;
    };

    const clock = { t: 0 };
    const early = meanOver(0, 10, clock);
    const late = meanOver(35, 60, clock);
    expect(Math.abs(late - early)).toBeGreaterThan(0.005);
  });

  it("flinchHead で頭が一瞬引いて戻る（startle 反射）", () => {
    const { vrm, getBone } = mockVrm();
    const bones = new ProceduralBones(() => 0.5);
    bones.bindVrm(vrm);

    // baseline（rest pitch bias のみ）
    bones.update(DT, 0, 1.0);
    const baseline = getBone("head").rotation.x;

    bones.flinchHead();
    let minX = baseline;
    let clock = 0;
    for (let t = 0; t < 0.45; t += DT) {
      clock += DT;
      bones.update(DT, clock, 1.0);
      minX = Math.min(minX, getBone("head").rotation.x);
    }
    // flinch のピークで baseline よりはっきり沈む
    expect(minX).toBeLessThan(baseline - 0.02);

    // flinch 終了後は baseline 近傍に戻る
    for (let t = 0; t < 0.5; t += DT) {
      clock += DT;
      bones.update(DT, clock, 1.0);
    }
    expect(getBone("head").rotation.x).toBeCloseTo(baseline, 2);
  });

  it("clearTransientReflexes で未再生の flinch を破棄する", () => {
    const { vrm, getBone } = mockVrm();
    const bones = new ProceduralBones(() => 0.5);
    bones.bindVrm(vrm);

    bones.update(DT, 0, 1.0);
    const baseline = getBone("head").rotation.x;

    bones.flinchHead();
    bones.clearTransientReflexes();
    for (let t = 0; t < 0.45; t += DT) {
      bones.update(DT, t, 1.0);
    }

    expect(getBone("head").rotation.x).toBeCloseTo(baseline, 5);
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

  it("default intensity で spine sway が非ゼロ＋有限レンジ", () => {
    const { vrm, getBone } = mockVrm();
    const bones = new ProceduralBones(() => 0.5);
    bones.bindVrm(vrm);

    let maxZ = 0;
    for (let t = 0; t < 10; t += DT) {
      bones.update(DT, t, 1.0);
      maxZ = Math.max(maxZ, Math.abs(getBone("spine").rotation.z));
    }
    expect(maxZ).toBeGreaterThan(0.001);
    expect(maxZ).toBeLessThan(0.1);
  });

  it("高 intensity でフレーム間速度（spine）が増加する", () => {
    const measure = (intensity: number): number => {
      const { vrm, getBone } = mockVrm();
      const bones = new ProceduralBones(seededRandom(42));
      bones.bindVrm(vrm);
      bones.setIntensity(intensity);

      let maxSpeed = 0;
      let prev = 0;
      for (let t = 0; t < 15; t += DT) {
        bones.update(DT, t, 1.0);
        const z = getBone("spine").rotation.z;
        maxSpeed = Math.max(maxSpeed, Math.abs(z - prev) / DT);
        prev = z;
      }
      return maxSpeed;
    };

    const speedDefault = measure(1.0);
    const speedHigh = measure(2.5);
    expect(speedHigh).toBeGreaterThan(speedDefault * 1.5);
  });

  it("高 intensity でフレーム間速度（head）が増加する", () => {
    const measure = (intensity: number): number => {
      const { vrm, getBone } = mockVrm();
      const originalRandom = Math.random;
      Math.random = () => 0;
      const bones = new ProceduralBones(seededRandom(42));
      Math.random = originalRandom;
      bones.bindVrm(vrm);
      bones.setIntensity(intensity);

      let maxSpeed = 0;
      let prev = 0;
      for (let t = 0; t < 15; t += DT) {
        bones.update(DT, t, 1.0);
        const z = getBone("head").rotation.z;
        maxSpeed = Math.max(maxSpeed, Math.abs(z - prev) / DT);
        prev = z;
      }
      return maxSpeed;
    };

    const speedDefault = measure(1.0);
    const speedHigh = measure(2.5);
    expect(speedHigh).toBeGreaterThan(speedDefault * 1.5);
  });

  it("arc: head tilt が非ゼロ時に pitch に連動が出る", () => {
    const { vrm, getBone } = mockVrm();
    const bones = new ProceduralBones(seededRandom(99));
    bones.bindVrm(vrm);

    for (let t = 0; t < 10; t += DT) bones.update(DT, t, 1.0);

    const headZ = getBone("head").rotation.z;
    const headX = getBone("head").rotation.x;
    if (Math.abs(headZ) > 0.005) {
      expect(headX).toBeLessThan(-0.03);
    }
  });

  it("arm は spine の動きに遅れて追従する（overlapping action）", () => {
    const { vrm, getBone } = mockVrm();
    const bones = new ProceduralBones(seededRandom(77));
    bones.bindVrm(vrm);
    bones.setIntensity(2.0);

    const spineHistory: number[] = [];
    const armHistory: number[] = [];
    for (let t = 0; t < 10; t += DT) {
      bones.update(DT, t, 1.0);
      spineHistory.push(getBone("spine").rotation.z);
      armHistory.push(getBone("leftUpperArm").rotation.z);
    }
    let correlation = 0;
    let laggedCorrelation = 0;
    const restZ = -1.35;
    const lag = 10;
    for (let i = lag; i < spineHistory.length; i++) {
      const armDelta = armHistory[i] - restZ;
      correlation += spineHistory[i] * armDelta;
      laggedCorrelation += spineHistory[i - lag] * armDelta;
    }
    expect(laggedCorrelation).toBeGreaterThan(correlation * 0.5);
  });

  it("addSpineEnvelope で spine が一時的に変化して settle する", () => {
    const base = mockVrm();
    const withEnvelope = mockVrm();
    const baseBones = new ProceduralBones(() => 0.5);
    const bones = new ProceduralBones(() => 0.5);
    baseBones.bindVrm(base.vrm);
    bones.bindVrm(withEnvelope.vrm);
    for (let t = 0; t < 1; t += DT) {
      baseBones.update(DT, t, 1.0);
      bones.update(DT, t, 1.0);
    }
    bones.addSpineEnvelope(0.02, 0, 0.2);
    let peak = 0;
    for (let t = 1; t < 2; t += DT) {
      baseBones.update(DT, t, 1.0);
      bones.update(DT, t, 1.0);
      const diff = withEnvelope.getBone("spine").rotation.z - base.getBone("spine").rotation.z;
      peak = Math.max(peak, Math.abs(diff));
    }
    expect(peak).toBeGreaterThan(0.0035);
    for (let t = 2; t < 4; t += DT) {
      baseBones.update(DT, t, 1.0);
      bones.update(DT, t, 1.0);
    }
    const finalDiff = withEnvelope.getBone("spine").rotation.z - base.getBone("spine").rotation.z;
    expect(Math.abs(finalDiff)).toBeLessThan(peak * 0.5);
  });

  it("addPostureEnvelope で posture が一時的にシフトして戻る", () => {
    const base = mockVrm();
    const withEnvelope = mockVrm();
    const baseBones = new ProceduralBones(() => 0.5);
    const bones = new ProceduralBones(() => 0.5);
    baseBones.bindVrm(base.vrm);
    bones.bindVrm(withEnvelope.vrm);
    for (let t = 0; t < 1; t += DT) {
      baseBones.update(DT, t, 1.0);
      bones.update(DT, t, 1.0);
    }
    bones.addPostureEnvelope(0.02, 0.5);
    for (let t = 1; t < 1.3; t += DT) {
      baseBones.update(DT, t, 1.0);
      bones.update(DT, t, 1.0);
    }
    const shifted = withEnvelope.getBone("spine").rotation.z - base.getBone("spine").rotation.z;
    expect(Math.abs(shifted)).toBeGreaterThan(0.005);
    for (let t = 1.3; t < 4; t += DT) {
      baseBones.update(DT, t, 1.0);
      bones.update(DT, t, 1.0);
    }
    const finalDiff = withEnvelope.getBone("spine").rotation.z - base.getBone("spine").rotation.z;
    expect(Math.abs(finalDiff)).toBeLessThan(Math.abs(shifted));
  });

  it("setActivityState('reading') は drift を増幅する(thinking family)", () => {
    const { vrm, getBone } = mockVrm();
    const bones = new ProceduralBones(seededRandom(31));
    bones.bindVrm(vrm);
    bones.setActivityState("reading");
    for (let t = 0; t < 5; t += DT) bones.update(DT, t, 1.0);
    expect(Math.abs(getBone("head").rotation.z)).toBeGreaterThan(0);
  });
});

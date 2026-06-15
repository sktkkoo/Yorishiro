/**
 * ProceduralBones — bone 直接操作層のテスト。
 *
 * 実 VRM なしで normalized bone stub に対する書き込みを検証する
 * （mockVrm パターンは vrm-rest-pose.test.ts と同じ）。
 */

import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { motionGain } from "./motion-gain";
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

  it("nudgeHeadToward で頭が指定方向に lerp で向かう（eye-head coordination）", () => {
    const { vrm, getBone } = mockVrm();
    const bones = new ProceduralBones(() => 0.5);
    bones.bindVrm(vrm);

    bones.nudgeHeadToward(0.08);
    for (let t = 0; t < 1; t += DT) bones.update(DT, t, 1.0);
    // 即時ジャンプではなく lerp で接近する（1 秒で目標の 5 割以上）
    const y = getBone("head").rotation.y;
    expect(y).toBeGreaterThan(0.04);
    expect(y).toBeLessThan(0.08);
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

    const sampleAt = (elapsed: number): number => {
      bones.update(DT, elapsed, 1.0);
      return getBone("spine").rotation.z;
    };
    // 旧実装 sin(elapsed * 0.6) の周期（2π/0.6）ぶん先と比較する
    const period = (Math.PI * 2) / 0.6;
    let maxDiff = 0;
    for (let t = 0; t < 20; t += 0.5) {
      maxDiff = Math.max(maxDiff, Math.abs(sampleAt(t) - sampleAt(t + period)));
    }
    expect(maxDiff).toBeGreaterThan(0.003);
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

  it("intensity 1.0 は spine sway が完全に不変（default 保証）", () => {
    const a = mockVrm();
    const b = mockVrm();
    const pa = new ProceduralBones(() => 0.5);
    pa.bindVrm(a.vrm);
    const pb = new ProceduralBones(() => 0.5);
    pb.bindVrm(b.vrm);
    pb.setIntensity(1.0);
    pa.update(DT, 2.0, 1.0);
    pb.update(DT, 2.0, 1.0);
    expect(b.getBone("spine").rotation.z).toBe(a.getBone("spine").rotation.z);
  });

  it("setIntensity が spine sway を motionGain('sway') 倍にする", () => {
    // rng=0.5 → head drift / posture のターゲットが 0 → spine.z は sway 成分のみ
    const a = mockVrm();
    const b = mockVrm();
    const pa = new ProceduralBones(() => 0.5);
    pa.bindVrm(a.vrm);
    const pb = new ProceduralBones(() => 0.5);
    pb.bindVrm(b.vrm);
    pb.setIntensity(2);
    pa.update(DT, 2.0, 1.0);
    pb.update(DT, 2.0, 1.0);
    const z1 = a.getBone("spine").rotation.z;
    const z2 = b.getBone("spine").rotation.z;
    expect(Math.abs(z1)).toBeGreaterThan(1e-6);
    expect(z2 / z1).toBeCloseTo(motionGain(2, "sway"), 5);
  });

  it("setIntensity が head drift（tilt）を motionGain('head') 倍にする", () => {
    // seed を揃えた2 instance はターゲット選択が同一 → 振幅のみ gain 差
    const a = mockVrm();
    const b = mockVrm();
    const originalRandom = Math.random;
    Math.random = () => 0;
    const pa = new ProceduralBones(seededRandom(20));
    const pb = new ProceduralBones(seededRandom(20));
    Math.random = originalRandom;
    pa.bindVrm(a.vrm);
    pb.bindVrm(b.vrm);
    pb.setIntensity(2);
    for (let t = 0; t < 4; t += DT) {
      pa.update(DT, t, 1.0);
      pb.update(DT, t, 1.0);
    }
    const z1 = a.getBone("head").rotation.z;
    const z2 = b.getBone("head").rotation.z;
    expect(Math.abs(z1)).toBeGreaterThan(1e-6);
    expect(z2 / z1).toBeCloseTo(motionGain(2, "head"), 4);
  });
});

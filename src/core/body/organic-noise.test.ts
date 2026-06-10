/**
 * OrganicNoise — 多重 sine 合成による有機的揺らぎのテスト。
 *
 * 単一 sine の機械的な周期性を消すための擬似ノイズ。値域・連続性・
 * 非周期性（短い窓では同じ波形が繰り返されない）を検証する。
 */

import { describe, expect, it } from "vitest";
import { OrganicNoise } from "./organic-noise";

/** 決定的な疑似乱数（mulberry32）。テストの再現性のため。 */
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

describe("OrganicNoise", () => {
  it("sample は常に [-1, 1] に収まる", () => {
    const noise = new OrganicNoise(1.0, seededRandom(42));
    for (let t = 0; t < 600; t += 0.05) {
      const v = noise.sample(t);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("連続: 微小な dt では値が飛ばない", () => {
    const noise = new OrganicNoise(1.0, seededRandom(7));
    let prev = noise.sample(0);
    for (let t = 0.016; t < 60; t += 0.016) {
      const v = noise.sample(t);
      expect(Math.abs(v - prev)).toBeLessThan(0.15);
      prev = v;
    }
  });

  it("非周期: 基本周波数 1 周期ぶん先の値が同じ波形を繰り返さない", () => {
    const noise = new OrganicNoise(1.0, seededRandom(13));
    // 基本周期 (2π/1.0) ごとにサンプルした値が一致し続けるなら単一 sine と同じ。
    const period = Math.PI * 2;
    let maxDiff = 0;
    for (let t = 0; t < 30; t += 0.5) {
      maxDiff = Math.max(maxDiff, Math.abs(noise.sample(t) - noise.sample(t + period)));
    }
    expect(maxDiff).toBeGreaterThan(0.2);
  });

  it("同じ random source なら同じ波形（再現性）", () => {
    const a = new OrganicNoise(1.0, seededRandom(99));
    const b = new OrganicNoise(1.0, seededRandom(99));
    for (let t = 0; t < 10; t += 0.7) {
      expect(a.sample(t)).toBeCloseTo(b.sample(t), 10);
    }
  });

  it("異なる random source なら波形が異なる（個体差）", () => {
    const a = new OrganicNoise(1.0, seededRandom(1));
    const b = new OrganicNoise(1.0, seededRandom(2));
    let maxDiff = 0;
    for (let t = 0; t < 10; t += 0.7) {
      maxDiff = Math.max(maxDiff, Math.abs(a.sample(t) - b.sample(t)));
    }
    expect(maxDiff).toBeGreaterThan(0.1);
  });

  it("baseFrequency が小さいほど変化が遅い", () => {
    const slow = new OrganicNoise(0.1, seededRandom(5));
    const fast = new OrganicNoise(2.0, seededRandom(5));
    const variation = (noise: OrganicNoise): number => {
      let sum = 0;
      let prev = noise.sample(0);
      for (let t = 0.1; t < 20; t += 0.1) {
        const v = noise.sample(t);
        sum += Math.abs(v - prev);
        prev = v;
      }
      return sum;
    };
    expect(variation(slow)).toBeLessThan(variation(fast));
  });
});

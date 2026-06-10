/**
 * BreathingSystem — 呼吸の生理のテスト。
 *
 * 累積位相方式（モード変更で波形が飛ばない）、state 連動の深さ・速さ、
 * ため息（deep breath）、息止め（startle 用 hold）を検証する。
 */

import { describe, expect, it } from "vitest";
import { BreathingSystem } from "./breathing-system";

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

const DT = 1 / 60;

/** durationS ぶん進め、|offsetY| の最大値を返す。 */
function peakOffsetY(sys: BreathingSystem, durationS: number): number {
  let peak = 0;
  for (let t = 0; t < durationS; t += DT) {
    peak = Math.max(peak, Math.abs(sys.update(DT).offsetY));
  }
  return peak;
}

describe("BreathingSystem", () => {
  it("offsetY が振動する（一定値に張り付かない）", () => {
    const sys = new BreathingSystem(seededRandom(1));
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let t = 0; t < 10; t += DT) {
      const v = sys.update(DT).offsetY;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(max - min).toBeGreaterThan(0.004);
  });

  it("chestPitch / shoulderLift も呼吸に同期して振動する", () => {
    const sys = new BreathingSystem(seededRandom(2));
    let chestRange = 0;
    let shoulderRange = 0;
    let chestMin = Number.POSITIVE_INFINITY;
    let chestMax = Number.NEGATIVE_INFINITY;
    let shMin = Number.POSITIVE_INFINITY;
    let shMax = Number.NEGATIVE_INFINITY;
    for (let t = 0; t < 10; t += DT) {
      const out = sys.update(DT);
      chestMin = Math.min(chestMin, out.chestPitch);
      chestMax = Math.max(chestMax, out.chestPitch);
      shMin = Math.min(shMin, out.shoulderLift);
      shMax = Math.max(shMax, out.shoulderLift);
    }
    chestRange = chestMax - chestMin;
    shoulderRange = shMax - shMin;
    expect(chestRange).toBeGreaterThan(0.005);
    expect(shoulderRange).toBeGreaterThan(0.002);
  });

  it("モード変更で出力が不連続に飛ばない（累積位相）", () => {
    const sys = new BreathingSystem(seededRandom(3));
    let prev = sys.update(DT).offsetY;
    for (let t = 0; t < 4; t += DT) prev = sys.update(DT).offsetY;
    sys.setMode("focused");
    for (let t = 0; t < 4; t += DT) {
      const v = sys.update(DT).offsetY;
      // 1 frame の変化は通常の波形勾配の範囲内（飛びがない）
      expect(Math.abs(v - prev)).toBeLessThan(0.001);
      prev = v;
    }
  });

  it("focused は relaxed より浅い呼吸になる", () => {
    const focused = new BreathingSystem(seededRandom(4));
    focused.setMode("focused");
    const relaxed = new BreathingSystem(seededRandom(4));
    relaxed.setMode("relaxed");
    // ため息の自発発火（25s+）より手前の窓で比較する
    peakOffsetY(focused, 5); // モード遷移の慣らし
    peakOffsetY(relaxed, 5);
    expect(peakOffsetY(focused, 15)).toBeLessThan(peakOffsetY(relaxed, 15));
  });

  it("triggerDeepBreath で通常より深い一呼吸が入る", () => {
    const sys = new BreathingSystem(seededRandom(5));
    sys.setMode("focused"); // 自発ため息が出ないモードで計測
    const normalPeak = peakOffsetY(sys, 12);
    sys.triggerDeepBreath();
    const deepPeak = peakOffsetY(sys, 8);
    expect(deepPeak).toBeGreaterThan(normalPeak * 1.4);
  });

  it("hold 中は呼吸が止まり、解除後に再開する", () => {
    const sys = new BreathingSystem(seededRandom(6));
    for (let t = 0; t < 3; t += DT) sys.update(DT);
    sys.hold(0.5);
    const atHold = sys.update(DT).offsetY;
    let maxDrift = 0;
    for (let t = 0; t < 0.45; t += DT) {
      maxDrift = Math.max(maxDrift, Math.abs(sys.update(DT).offsetY - atHold));
    }
    expect(maxDrift).toBeLessThan(0.0005);
    // 解除後は振動が戻る
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let t = 0; t < 10; t += DT) {
      const v = sys.update(DT).offsetY;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(max - min).toBeGreaterThan(0.003);
  });

  it("idle では自発的なため息が時々入る", () => {
    const sys = new BreathingSystem(seededRandom(7));
    // 20s 慣らし → 基準ピーク
    const basePeak = peakOffsetY(sys, 15);
    // ため息周期（25-50s）を跨ぐ 70s で deep breath のピークを観測
    const longPeak = peakOffsetY(sys, 70);
    expect(longPeak).toBeGreaterThan(basePeak * 1.4);
  });
});

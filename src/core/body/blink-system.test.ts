/**
 * BlinkSystem 拡張のテスト — requestBlink / state 連動間隔 / double blink。
 *
 * 基本の state machine（timing / suppress / resume）は body.test.ts 側にある。
 * ここでは「生きている瞬き」のための拡張挙動のみを検証する。
 */

import { describe, expect, it } from "vitest";
import { BlinkSystem } from "./blink-system";

const DT = 1 / 60;

/** durationS の間 update し、blink 開始（非 active → active）時刻を集める。 */
function collectBlinkStarts(blink: BlinkSystem, durationS: number): number[] {
  const starts: number[] = [];
  let prevValue = 0;
  for (let t = 0; t < durationS; t += DT) {
    const v = blink.update(DT);
    if (prevValue === 0 && v > 0) starts.push(t);
    prevValue = v;
  }
  return starts;
}

describe("BlinkSystem extensions", () => {
  it("requestBlink で即時に瞬きが始まる", () => {
    const blink = new BlinkSystem(() => 0.5);
    // 通常なら最初の瞬きまで 4 秒以上かかる
    blink.update(DT);
    blink.requestBlink();
    let maxValue = 0;
    for (let t = 0; t < 0.3; t += DT) {
      maxValue = Math.max(maxValue, blink.update(DT));
    }
    expect(maxValue).toBe(1.0);
  });

  it("suppress 中の requestBlink は無視される", () => {
    const blink = new BlinkSystem(() => 0.5);
    blink.suppress();
    blink.requestBlink();
    let maxValue = 0;
    for (let t = 0; t < 1; t += DT) {
      maxValue = Math.max(maxValue, blink.update(DT));
    }
    expect(maxValue).toBe(0);
  });

  it("集中 state（reading）では idle より瞬きが減る", () => {
    const idle = new BlinkSystem(() => 0.5);
    const reading = new BlinkSystem(() => 0.5);
    reading.setState("reading");
    const idleCount = collectBlinkStarts(idle, 90).length;
    const readingCount = collectBlinkStarts(reading, 90).length;
    expect(readingCount).toBeLessThan(idleCount);
  });

  it("double blink: 高 rng では 1 秒未満の間隔で連続瞬きが入る", () => {
    const blink = new BlinkSystem(() => 0.99);
    const starts = collectBlinkStarts(blink, 15);
    expect(starts.length).toBeGreaterThanOrEqual(2);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    expect(Math.min(...gaps)).toBeLessThan(1.0);
  });

  it("低 rng では double blink は発生しない（間隔は常に 2 秒以上）", () => {
    const blink = new BlinkSystem(() => 0);
    const starts = collectBlinkStarts(blink, 20);
    expect(starts.length).toBeGreaterThanOrEqual(2);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    expect(Math.min(...gaps)).toBeGreaterThan(2.0);
  });
});

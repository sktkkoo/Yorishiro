/**
 * EyeSystem 拡張のテスト — saccade イベントの公開（eye-head coordination 用）。
 *
 * 基本の saccade/fixation/override は body.test.ts 側にある。ここでは
 * consumeSaccadeEvent() の pull 契約と blinkWorthy 判定のみを検証する。
 */

import { describe, expect, it } from "vitest";
import { EyeSystem } from "./eye-system";

const DT = 1 / 60;

describe("EyeSystem saccade event", () => {
  it("初期状態では event は無い", () => {
    const eye = new EyeSystem(() => 0);
    expect(eye.consumeSaccadeEvent()).toBeNull();
  });

  it("saccade 開始で event が立ち、consume で消える", () => {
    // rng=0: 初回 fixation 2.0s → patterns[0]（左 1.0）への saccade
    const eye = new EyeSystem(() => 0);
    for (let t = 0; t < 2.1; t += DT) eye.update(DT);
    const event = eye.consumeSaccadeEvent();
    expect(event).not.toBeNull();
    expect(event?.magnitude).toBeCloseTo(1.0, 3);
    expect(event?.targetYawDeg).toBeCloseTo(30, 3); // left 1.0 → +30°
    expect(eye.consumeSaccadeEvent()).toBeNull();
  });

  it("大きい saccade + 低 rng は blinkWorthy になる", () => {
    const eye = new EyeSystem(() => 0); // blink 抽選 0 < 0.3
    for (let t = 0; t < 2.1; t += DT) eye.update(DT);
    expect(eye.consumeSaccadeEvent()?.blinkWorthy).toBe(true);
  });

  it("blink 抽選に外れた saccade は blinkWorthy にならない", () => {
    // rng=0.45: patterns[3]（up0.3/right0.8, dist≈0.85）だが抽選 0.45 ≥ 0.3
    const eye = new EyeSystem(() => 0.45);
    for (let t = 0; t < 3.4; t += DT) eye.update(DT);
    expect(eye.consumeSaccadeEvent()?.blinkWorthy).toBe(false);
  });

  it("refocusFront で次の saccade が正面に向かう（注意の切り替え）", () => {
    // rng=0: 通常なら patterns[0]（左）ばかり選ぶ
    const eye = new EyeSystem(() => 0);
    for (let t = 0; t < 2.5; t += DT) eye.update(DT); // 左へ saccade 済み
    expect(Math.abs(eye.getOutput().yaw)).toBeGreaterThan(10);

    eye.refocusFront();
    for (let t = 0; t < 0.5; t += DT) eye.update(DT);
    expect(Math.abs(eye.getOutput().yaw)).toBeLessThan(2);
  });

  it("正面 → 正面の縮退 saccade は event を出さない", () => {
    // rng=0.8: patterns[6]（front）→ 初期位置も front なので magnitude 0
    const eye = new EyeSystem(() => 0.8);
    for (let t = 0; t < 4.5; t += DT) eye.update(DT);
    expect(eye.consumeSaccadeEvent()).toBeNull();
  });
});

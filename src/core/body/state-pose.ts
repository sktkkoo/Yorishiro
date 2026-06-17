/**
 * StatePose — 状態ごとの持続ポーズとテンポ。
 *
 * 状態（idle/thinking/reading/writing/running）を姿勢のシルエットと
 * 動きのテンポで表現する。beat や視線より salience が高く、intensity とは
 * 別軸なので motion size を上げても状態差が残る。
 *
 * 符号は rig 依存（spinePitch の前傾向き / headPitch の上下）。実機で確認し、
 * 必要なら反転する。値は帰納調整の出発点。
 *
 * Internal design-record: 2026-06-17-motion-statepose-p4-design.md §2.2
 */

import type { EyeState } from "./eye-system";

export interface StatePose {
  /** 前傾（+）/ 起こす（-）。spine.rotation.x に加算する。 */
  readonly spinePitch: number;
  /** 見上げ（+）/ うつむき（-）。head.rotation.x に加算する。 */
  readonly headPitch: number;
  /** 連続スウェイの倍率。intensity の後に掛ける相対倍率。 */
  readonly swayScale: number;
  /** head drift 振幅の倍率。従来の一律 x1.8 を置換する。 */
  readonly driftAmpScale: number;
  /** head drift 間隔の倍率。 */
  readonly driftIntervalScale: number;
}

// reading / writing は body では区別せず「集中作業」として同一ポーズに統合する。
// 視線（EyeSystem）は per-state のままなので、視線方向の微差だけが残る。
const FOCUSED_WORK: StatePose = {
  spinePitch: 0.06,
  headPitch: -0.09,
  swayScale: 0.35,
  driftAmpScale: 0.5,
  driftIntervalScale: 1.2,
};

export const STATE_POSE: Record<EyeState, StatePose> = {
  idle: {
    spinePitch: 0,
    headPitch: 0,
    swayScale: 1.0,
    driftAmpScale: 1.0,
    driftIntervalScale: 1.0,
  },
  thinking: {
    spinePitch: -0.015,
    headPitch: 0.06,
    swayScale: 0.6,
    driftAmpScale: 1.4,
    driftIntervalScale: 0.9,
  },
  reading: FOCUSED_WORK,
  writing: FOCUSED_WORK,
  running: {
    spinePitch: 0.02,
    headPitch: 0.03,
    swayScale: 0.8,
    driftAmpScale: 1.0,
    driftIntervalScale: 1.0,
  },
};

const BLEND_SPEED = 2.0;
const SNAP_EPSILON = 0.002;

function approach(current: number, target: number, t: number): number {
  const next = current + (target - current) * t;
  return Math.abs(target - next) < SNAP_EPSILON ? target : next;
}

/** 現在ポーズを target へクロスフェードする。 */
export class StatePoseBlender {
  spinePitch: number;
  headPitch: number;
  swayScale: number;
  driftAmpScale: number;
  driftIntervalScale: number;
  private target: StatePose;

  constructor(initial: EyeState = "idle") {
    const p = STATE_POSE[initial];
    this.spinePitch = p.spinePitch;
    this.headPitch = p.headPitch;
    this.swayScale = p.swayScale;
    this.driftAmpScale = p.driftAmpScale;
    this.driftIntervalScale = p.driftIntervalScale;
    this.target = p;
  }

  setState(state: EyeState): void {
    this.target = STATE_POSE[state];
  }

  update(delta: number): void {
    const t = Math.min(BLEND_SPEED * delta, 1.0);
    this.spinePitch = approach(this.spinePitch, this.target.spinePitch, t);
    this.headPitch = approach(this.headPitch, this.target.headPitch, t);
    this.swayScale = approach(this.swayScale, this.target.swayScale, t);
    this.driftAmpScale = approach(this.driftAmpScale, this.target.driftAmpScale, t);
    this.driftIntervalScale = approach(this.driftIntervalScale, this.target.driftIntervalScale, t);
  }
}

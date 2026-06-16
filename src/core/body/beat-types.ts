/**
 * Procedural Pose Beat System — 型定義。
 *
 * beat は単なる impulse ではなく、anticipation → key → settle の
 * keyframe sequence を持つ procedural pose beat。
 * Phase 2 の spring が follow-through / settle を補助する。
 *
 * staging(1 beat = 1 主役)は型ではなく規約として beat 定義時に守る。
 * Pure type definitions, no runtime logic.
 */

import type { EyeState } from "./eye-system";

export interface BeatTarget {
  /** 視線を一時的に向ける(eye-lead)。EyeSystem.triggerGlance を呼び pendingSaccade を発行、頭は eye-head coordination で追従。durationS 後に自動 release。 */
  glance(yawRad: number, pitchRad: number, durationS: number): void;
  /** spine spring target に transient envelope を追加。durationS 後に 0 に戻る。 */
  addSpineEnvelope(z: number, x: number, durationS: number): void;
  /** posture バイアスを envelope で一時変更。durationS 後に 0 に戻る。 */
  addPostureEnvelope(leanZ: number, durationS: number): void;
  /** 深呼吸 1 回(既存 API)。 */
  triggerDeepBreath(): void;
  /** 瞬き 1 回(既存 API)。 */
  requestBlink(): void;
  /** 既存 IdleMicroexpressionSystem に one-shot episode を注入。 */
  injectMicroExpression(region: "brow" | "mouth", weight: number, durationS: number): void;
}

export type BeatWeight = "light" | "medium" | "heavy";

export interface BeatPose {
  readonly gaze?: { readonly yaw: number; readonly pitch: number; readonly durationS: number };
  readonly spine?: { readonly z?: number; readonly x?: number; readonly durationS: number };
  readonly posture?: { readonly leanZ: number; readonly durationS: number };
}

export interface BeatKeyframe {
  /** sequence 開始からの遅延(秒)。 */
  readonly at: number;
  /** target pose(intent)。 */
  readonly pose: BeatPose;
}

export interface BeatSecondaryAction {
  readonly at: number;
  readonly fire: (target: BeatTarget) => void;
}

export interface BeatDef {
  readonly name: string;
  /** 同一 beat の最小再発間隔(秒)。 */
  readonly cooldown: number;
  /** 重さ。budget 制御に使う。 */
  readonly weight: BeatWeight;
  /** keyframes。anticipation → key → settle の順。 */
  readonly keyframes: ReadonlyArray<BeatKeyframe>;
  /** secondary actions(blink / micro expression)。 */
  readonly secondaryActions?: ReadonlyArray<BeatSecondaryAction>;
}

export interface BeatProfile {
  readonly beats: ReadonlyArray<BeatDef>;
  readonly baseInterval: number;
  readonly scaleWithIntensity: boolean;
}

export type BeatProfileMap = Record<EyeState, BeatProfile>;

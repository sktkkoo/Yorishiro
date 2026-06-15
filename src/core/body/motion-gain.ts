/**
 * motionGain — idle procedural motion の実効振幅倍率。
 *
 * `effectiveAmp = baseAmp * motionGain(intensity, axis)`。
 * 契約: motionGain(1.0, *) === 1.0（default = 現状の見え方を完全維持）。
 * 軸別指数で「頭はよく動くが呼吸は暴れない」非対称な dynamic range を作る。
 *
 * NOTE: 指数値は帰納調整の出発点（実機観察で詰める）。
 * Internal design-record: 2026-06-16-motion-intensity-design.md §5.2
 *
 * Pure data logic, no VRM dependency.
 */

export type MotionAxis = "head" | "sway" | "posture" | "breathing";

const MOTION_GAIN_EXPONENT: Record<MotionAxis, number> = {
  head: 1.4,
  sway: 1.2,
  posture: 1.1,
  breathing: 0.6,
};

/** intensity（0 以上）と軸から実効振幅倍率を返す。intensity=1 で必ず 1.0。 */
export function motionGain(intensity: number, axis: MotionAxis): number {
  const safe = Number.isFinite(intensity) ? Math.max(0, intensity) : 1.0;
  return safe ** MOTION_GAIN_EXPONENT[axis];
}

export interface MotionSpringParams {
  readonly spineOmega: number;
  readonly spineZeta: number;
  readonly headOmega: number;
  readonly headZeta: number;
  /** head drift の既存 timer に乗算するスケール。低 intensity で遅く、高で速く。 */
  readonly headTimerScale: number;
  readonly armOmega: number;
  readonly armZeta: number;
}

function clampedLerp(a: number, b: number, t: number): number {
  const ct = Math.max(0, Math.min(1, t));
  return a + (b - a) * ct;
}

/**
 * intensity から spring パラメータ群を算出する。
 * 各値は帰納調整の出発点。
 */
export function springParams(intensity: number): MotionSpringParams {
  const safe = Number.isFinite(intensity) ? Math.max(0, intensity) : 1.0;
  const t = (safe - 0.5) / 2.5;

  const spineOmega = Math.max(1, Math.min(15, clampedLerp(3.0, 8.0, t)));
  const spineZeta = Math.max(0.2, Math.min(1.2, clampedLerp(0.9, 0.35, t)));

  const headOmega = Math.max(1, Math.min(15, clampedLerp(3.0, 10.0, t)));
  const headZeta = Math.max(0.2, Math.min(1.2, clampedLerp(0.85, 0.3, t)));
  const headTimerScale = Math.max(0.2, clampedLerp(1.3, 0.4, t));

  const armOmega = Math.max(1, spineOmega * 0.5);
  const armZeta = 0.85;

  return {
    spineOmega,
    spineZeta,
    headOmega,
    headZeta,
    headTimerScale,
    armOmega,
    armZeta,
  };
}

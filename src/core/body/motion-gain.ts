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

/**
 * Flicker pattern functions. lantern (warm, irregular) と CRT (cool, signal).
 * Pure functions of time -> intensity. useFrame の中で呼ばれる.
 *
 * Spec §7.2 (lantern), §7.3 (CRT).
 */

import { perlin1d } from "./perlin";

const LANTERN_BASE = 1.4;
const CRT_BASE = 0.5;

export interface FlickerParams {
  /** flicker 変動幅の倍率. 0 で完全に安定、1 で default の振幅 */
  readonly flickerAmount: number;
}

const DEFAULT_FLICKER: FlickerParams = { flickerAmount: 1.0 };

/**
 * Lantern intensity: base sin + Perlin irregularity + rare dropout.
 * flickerAmount で振幅を絞れる（0 = 完全安定、1 = spec 通り）.
 */
export function computeLanternFlicker(t: number, params: FlickerParams = DEFAULT_FLICKER): number {
  const a = params.flickerAmount;
  const baseWave = Math.sin(t * 4.4) * 0.2 * a;
  const noise = (perlin1d(t * 19.7) * 0.15 + perlin1d(t * 31.3) * 0.1) * a;
  const dropoutSeed = perlin1d(Math.floor(t * 4));
  const dropout = dropoutSeed > 0.85 ? 1.0 - 0.85 * a : 1.0;
  return Math.max(0.05, (LANTERN_BASE + baseWave + noise) * dropout);
}

/**
 * CRT intensity: 高頻度 noise + 低頻度 signal shift.
 * flickerAmount で振幅を絞れる（0 = 完全安定、1 = spec 通り）.
 */
export function computeCrtFlicker(t: number, params: FlickerParams = DEFAULT_FLICKER): number {
  const a = params.flickerAmount;
  const highFreq = (Math.sin(t * 75.4) + Math.sin(t * 113.7)) * 0.025 * a;
  const signalShift = Math.sin(t * 1.88) * 0.15 * a;
  return Math.max(0.1, CRT_BASE + highFreq + signalShift);
}

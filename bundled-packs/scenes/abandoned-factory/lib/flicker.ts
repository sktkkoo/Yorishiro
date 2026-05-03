/**
 * Flicker pattern functions. lantern (warm, irregular) と CRT (cool, signal).
 * Pure functions of time -> intensity. useFrame の中で呼ばれる.
 *
 * Spec §7.2 (lantern), §7.3 (CRT).
 */

import { perlin1d } from "./perlin";

const LANTERN_BASE = 1.4;
const CRT_BASE = 0.5;

/**
 * Lantern intensity: base sin + Perlin irregularity + rare dropout.
 */
export function computeLanternFlicker(t: number): number {
  const baseWave = Math.sin(t * 4.4) * 0.2;
  const noise = perlin1d(t * 19.7) * 0.15 + perlin1d(t * 31.3) * 0.1;
  const dropoutSeed = perlin1d(Math.floor(t * 4));
  const dropout = dropoutSeed > 0.85 ? 0.15 : 1.0;
  return Math.max(0.05, (LANTERN_BASE + baseWave + noise) * dropout);
}

/**
 * CRT intensity: 高頻度 noise + 低頻度 signal shift.
 */
export function computeCrtFlicker(t: number): number {
  const highFreq = (Math.sin(t * 75.4) + Math.sin(t * 113.7)) * 0.025;
  const signalShift = Math.sin(t * 1.88) * 0.15;
  return Math.max(0.1, CRT_BASE + highFreq + signalShift);
}

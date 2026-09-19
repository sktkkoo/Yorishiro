/**
 * Convert the public 0–3 setting to the existing motion system's strength.
 * Normal is quieter for terminal work; Lively retains the former Normal.
 * Over keeps the reviewed maximum, including the existing clip-weight caps.
 */
export function calibratedMotionIntensity(setting: number): number {
  const value = Number.isFinite(setting) ? Math.max(0, Math.min(3, setting)) : 1;
  return value <= 2 ? value / 2 : 1 + (value - 2) * 2;
}

/**
 * Authored performances reach their reviewed ceiling at Lively and above.
 * Standard keeps the individual baseline; this does not scale source time or
 * the separate standing support/procedural layers.
 */
export function automaticPerformanceWeight(
  setting: number,
  standardWeight: number,
  maxWeight = 1,
): number {
  const value = Number.isFinite(setting) ? Math.max(0, Math.min(3, setting)) : 1;
  const ceiling = Number.isFinite(maxWeight) ? Math.max(0, Math.min(1, maxWeight)) : 1;
  const standard = Number.isFinite(standardWeight)
    ? Math.max(0, Math.min(ceiling, standardWeight))
    : 0;
  return value <= 1 ? standard * value : standard + (ceiling - standard) * Math.min(1, value - 1);
}

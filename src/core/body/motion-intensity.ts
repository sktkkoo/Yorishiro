/**
 * Convert the public 0–3 setting to the existing motion system's strength.
 * Normal is quieter for terminal work; Lively retains the former Normal.
 * Over keeps the reviewed maximum, including the existing clip-weight caps.
 */
export function calibratedMotionIntensity(setting: number): number {
  const value = Number.isFinite(setting) ? Math.max(0, Math.min(3, setting)) : 1;
  return value <= 2 ? value / 2 : 1 + (value - 2) * 2;
}

/** 数値の線形補間。 */
export function numberLerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ─── Easing functions ────────────────────────────────────────

export type EasingFn = (t: number) => number;

export const easeLinear: EasingFn = (t) => t;
export const easeOutCubic: EasingFn = (t) => 1 - (1 - t) ** 3;
export const easeInOutCubic: EasingFn = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

/** [x, y, z] の component-wise 線形補間。 */
export function vec3Lerp(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * "#rrggbb" hex 文字列の RGB 空間線形補間。
 * THREE.Color を使わず純粋関数として実装（テストが THREE 非依存になる）。
 */
export function colorLerp(a: string, b: string, t: number): string {
  const parse = (s: string, i: number) => Number.parseInt(s.slice(i, i + 2), 16);
  const mix = (ca: number, cb: number) => Math.round(ca + (cb - ca) * t);
  const r = mix(parse(a, 1), parse(b, 1));
  const g = mix(parse(a, 3), parse(b, 3));
  const bv = mix(parse(a, 5), parse(b, 5));
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bv.toString(16).padStart(2, "0")}`;
}

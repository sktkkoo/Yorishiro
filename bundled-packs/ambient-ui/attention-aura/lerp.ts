/**
 * Aura の補間 / 収束判定 / fade-out 計算 (すべて pure 関数)。
 *
 * - `lerp(a, b, t)`: 線形補間
 * - `lerpView`: rect + opacity の view state を一括補間
 * - `isConverged`: current ≒ target なら true (RAF pause 判定)
 * - `fadeOutOpacity`: startOpacity から fadeDurationS で 0 に線形減衰
 */

const CONVERGENCE_EPSILON_PX = 0.5;
const CONVERGENCE_EPSILON_OPACITY = 0.005;

export interface AuraView {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly opacity: number;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpView(current: AuraView, target: AuraView, t: number): AuraView {
  return {
    x: lerp(current.x, target.x, t),
    y: lerp(current.y, target.y, t),
    width: lerp(current.width, target.width, t),
    height: lerp(current.height, target.height, t),
    opacity: lerp(current.opacity, target.opacity, t),
  };
}

export function isConverged(current: AuraView, target: AuraView): boolean {
  return (
    Math.abs(current.x - target.x) < CONVERGENCE_EPSILON_PX &&
    Math.abs(current.y - target.y) < CONVERGENCE_EPSILON_PX &&
    Math.abs(current.width - target.width) < CONVERGENCE_EPSILON_PX &&
    Math.abs(current.height - target.height) < CONVERGENCE_EPSILON_PX &&
    Math.abs(current.opacity - target.opacity) < CONVERGENCE_EPSILON_OPACITY
  );
}

export interface FadeOutState {
  readonly startOpacity: number;
  readonly elapsedS: number;
}

export function fadeOutOpacity(fade: FadeOutState, fadeDurationS: number): number {
  if (fade.elapsedS >= fadeDurationS) return 0;
  const progress = fade.elapsedS / fadeDurationS;
  return fade.startOpacity * (1 - progress);
}

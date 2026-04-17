/**
 * Shake — ランダム変位の offset を時間に対して減衰させる pure 関数。
 * EffectDispatcher の subscriber 側で requestAnimationFrame 毎にこの関数を呼び、
 * 返った dx / dy を DOM element の transform translate に適用する。
 *
 * 旧 Charminal の shake（500ms / 8px decay）の型を踏襲。intensity 1.0 で最大
 * 変位 20px 程度を狙う（SHAKE_MAX_PX）。
 */

const SHAKE_MAX_PX = 20;

export interface ShakeOffset {
  readonly dx: number;
  readonly dy: number;
}

/**
 * Compute the translate offset at a given elapsed time within a shake effect.
 * Returns {0,0} once elapsedMs >= durationMs, or when intensity is 0.
 *
 * @param random — Supplies values in [0, 1). In production pass Math.random;
 *                 in tests pass a seeded PRNG for determinism.
 */
export const computeShakeOffset = (
  elapsedMs: number,
  durationMs: number,
  intensity: number,
  random: () => number,
): ShakeOffset => {
  if (elapsedMs >= durationMs || durationMs <= 0) return { dx: 0, dy: 0 };
  if (intensity <= 0) return { dx: 0, dy: 0 };
  const decay = 1 - elapsedMs / durationMs;
  const amplitude = SHAKE_MAX_PX * intensity * decay;
  const dx = (random() - 0.5) * 2 * amplitude;
  const dy = (random() - 0.5) * 2 * amplitude;
  return { dx, dy };
};

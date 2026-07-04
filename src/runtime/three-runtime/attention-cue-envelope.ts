/**
 * AttentionCueLight の 2-pulse envelope（純関数）。
 *
 * 旧 runtime 直注入の attention-flash-light.tsx から移植。cue（AttentionLightCue）
 * が発火してからの経過秒数を渡すと、fade-in/fade-out する 2 回の pulse の
 * 強度を返す。値そのものは実機確認に合わせて帰納的に調整する。
 */

export const ATTENTION_CUE_PULSE_COUNT = 2;
export const ATTENTION_CUE_PULSE_DURATION_SECONDS = 1.7;
export const ATTENTION_CUE_DURATION_SECONDS =
  ATTENTION_CUE_PULSE_DURATION_SECONDS * ATTENTION_CUE_PULSE_COUNT;

export interface AttentionCueLightIntensity {
  readonly ambient: number;
  readonly point: number;
  readonly spot: number;
}

const ATTENTION_CUE_PEAK_INTENSITY: AttentionCueLightIntensity = {
  ambient: 0.02,
  point: 0.18,
  spot: 0.21,
};

export function computeAttentionCueLightIntensity(
  elapsedSeconds: number,
): AttentionCueLightIntensity {
  if (elapsedSeconds <= 0 || elapsedSeconds >= ATTENTION_CUE_DURATION_SECONDS) {
    return { ambient: 0, point: 0, spot: 0 };
  }
  const pulseElapsed = elapsedSeconds % ATTENTION_CUE_PULSE_DURATION_SECONDS;
  const progress = pulseElapsed / ATTENTION_CUE_PULSE_DURATION_SECONDS;
  const fade = progress < 0.5 ? smootherstep(progress * 2) : smootherstep((1 - progress) * 2);
  return {
    ambient: ATTENTION_CUE_PEAK_INTENSITY.ambient * fade,
    point: ATTENTION_CUE_PEAK_INTENSITY.point * fade,
    spot: ATTENTION_CUE_PEAK_INTENSITY.spot * fade,
  };
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function smootherstep(value: number): number {
  const x = clamp01(value);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

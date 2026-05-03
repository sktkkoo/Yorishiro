/**
 * Event-driven glitch system (spec §8.3).
 *
 * 3 種類の event-driven glitch を time-based threshold で発火:
 * 1. Brief glitch moments — pixel scramble / CA spike (30–90 秒に一度)
 * 2. Lantern flicker-spike 同期 — lantern dropout 時に CA も spike
 * 3. Heavy noise burst — VHS dropout 風 (数分に一度)
 *
 * pure function + state object pattern. useFrame から毎フレーム呼ばれ、
 * 現在の glitch 強度を返す.
 */

import { perlin1d } from "./perlin";

/** glitch 系パラメータ. leva controls で runtime 調整. */
export interface GlitchParams {
  /** brief glitch の最小間隔 (秒) */
  readonly briefIntervalMin: number;
  /** brief glitch の最大間隔 (秒) */
  readonly briefIntervalMax: number;
  /** brief glitch 持続時間 (秒) */
  readonly briefDuration: number;
  /** brief glitch 時の CA offset 倍率 */
  readonly briefCaMultiplier: number;

  /** lantern dropout threshold (これ以下で CA spike) */
  readonly lanternSyncThreshold: number;
  /** lantern sync 時の CA offset 倍率 */
  readonly lanternSyncCaMultiplier: number;

  /** heavy burst の最小間隔 (秒) */
  readonly heavyIntervalMin: number;
  /** heavy burst の最大間隔 (秒) */
  readonly heavyIntervalMax: number;
  /** heavy burst 持続時間 (秒) */
  readonly heavyDuration: number;
  /** heavy burst 時の noise opacity 加算 */
  readonly heavyNoiseAdd: number;
  /** heavy burst 時の scanline opacity 倍率 */
  readonly heavyScanlineMultiplier: number;
}

export const DEFAULT_GLITCH_PARAMS: GlitchParams = {
  // TODO: 確認用に短縮中。確定後に元の値に戻す (30/90, 120/300)
  briefIntervalMin: 3,
  briefIntervalMax: 6,
  briefDuration: 0.15,
  briefCaMultiplier: 4.0,

  lanternSyncThreshold: 0.4,
  lanternSyncCaMultiplier: 2.5,

  heavyIntervalMin: 8,
  heavyIntervalMax: 15,
  heavyDuration: 0.3,
  heavyNoiseAdd: 0.4,
  heavyScanlineMultiplier: 8.0,
};

/** 各 glitch event の current 強度 (0–1). post-process が modulation に使う. */
export interface GlitchOutput {
  /** brief glitch 活性度 (0 = 非活性, 1 = ピーク) */
  readonly briefIntensity: number;
  /** lantern sync 活性度 */
  readonly lanternSyncIntensity: number;
  /** heavy burst 活性度 */
  readonly heavyIntensity: number;
}

/** mutable state. React の外で ref として保持. */
export interface GlitchState {
  /** 次の brief glitch の発火時刻 */
  nextBriefAt: number;
  /** brief glitch が発火した時刻 (-1 で非活性) */
  briefFiredAt: number;
  /** 次の heavy burst の発火時刻 */
  nextHeavyAt: number;
  /** heavy burst が発火した時刻 (-1 で非活性) */
  heavyFiredAt: number;
}

/** glitch state を初期化. scene mount 時に呼ぶ. */
export function createGlitchState(startTime: number, params: GlitchParams): GlitchState {
  return {
    nextBriefAt: startTime + randomRange(params.briefIntervalMin, params.briefIntervalMax),
    briefFiredAt: -1,
    nextHeavyAt: startTime + randomRange(params.heavyIntervalMin, params.heavyIntervalMax),
    heavyFiredAt: -1,
  };
}

/**
 * 毎フレーム呼び出し. state を変更し、現在の glitch 強度を返す.
 *
 * @param t - clock.getElapsedTime()
 * @param lanternIntensity - 現フレームの lantern flicker 生値
 * @param state - mutable state (ref で保持)
 * @param params - leva から取得した glitch パラメータ
 */
export function updateGlitches(
  t: number,
  lanternIntensity: number,
  state: GlitchState,
  params: GlitchParams,
): GlitchOutput {
  // --- Brief glitch ---
  let briefIntensity = 0;
  if (t >= state.nextBriefAt && state.briefFiredAt < 0) {
    state.briefFiredAt = t;
  }
  if (state.briefFiredAt >= 0) {
    const elapsed = t - state.briefFiredAt;
    if (elapsed < params.briefDuration) {
      // triangle envelope: 0 → 1 → 0
      const half = params.briefDuration / 2;
      briefIntensity = elapsed < half ? elapsed / half : 1 - (elapsed - half) / half;
      // high-frequency jitter をかぶせる
      briefIntensity *= 0.7 + 0.3 * Math.abs(perlin1d(t * 120));
    } else {
      // 終了 → 次回スケジュール
      state.briefFiredAt = -1;
      state.nextBriefAt = t + randomRange(params.briefIntervalMin, params.briefIntervalMax);
    }
  }

  // --- Lantern sync ---
  let lanternSyncIntensity = 0;
  if (lanternIntensity < params.lanternSyncThreshold) {
    // lantern が閾値以下 → 同期的に CA spike
    // 閾値からの距離で強度を決定 (0=閾値ぎりぎり, 1=ほぼ消灯)
    lanternSyncIntensity = Math.min(
      1,
      (params.lanternSyncThreshold - lanternIntensity) / params.lanternSyncThreshold,
    );
  }

  // --- Heavy noise burst ---
  let heavyIntensity = 0;
  if (t >= state.nextHeavyAt && state.heavyFiredAt < 0) {
    state.heavyFiredAt = t;
  }
  if (state.heavyFiredAt >= 0) {
    const elapsed = t - state.heavyFiredAt;
    if (elapsed < params.heavyDuration) {
      // sharp attack, exponential decay
      const progress = elapsed / params.heavyDuration;
      heavyIntensity = progress < 0.1 ? progress / 0.1 : Math.exp(-3 * (progress - 0.1));
      // scramble texture
      heavyIntensity *= 0.8 + 0.2 * Math.abs(Math.sin(t * 200));
    } else {
      state.heavyFiredAt = -1;
      state.nextHeavyAt = t + randomRange(params.heavyIntervalMin, params.heavyIntervalMax);
    }
  }

  return { briefIntensity, lanternSyncIntensity, heavyIntensity };
}

/** min–max の一様乱数. perlin seed で pseudo-random. */
function randomRange(min: number, max: number): number {
  // Math.random で十分 (非決定論的で良い. event timing は再現不要)
  return min + Math.random() * (max - min);
}

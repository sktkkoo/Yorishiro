export interface OutputTimingSample {
  readonly contextTimeSeconds: number;
  readonly performanceNowMs: number;
  readonly baseLatencySeconds?: number;
  readonly outputLatencySeconds?: number;
  readonly outputContextTimeSeconds?: number;
  readonly outputPerformanceTimeMs?: number;
}

const nonnegative = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** 測定専用。各時計は口と実音声の遅延を校正した値ではない。 */
export function captureOutputTiming(context: AudioContext): OutputTimingSample {
  let stamp: AudioTimestamp | undefined;
  try {
    stamp = context.getOutputTimestamp?.();
  } catch {
    // メソッドが存在しても出力 timestamp を取得できない WebView がある。
  }
  return {
    contextTimeSeconds: context.currentTime,
    performanceNowMs: performance.now(),
    baseLatencySeconds: nonnegative(context.baseLatency),
    outputLatencySeconds: nonnegative(context.outputLatency),
    outputContextTimeSeconds: nonnegative(stamp?.contextTime),
    outputPerformanceTimeMs: nonnegative(stamp?.performanceTime),
  };
}

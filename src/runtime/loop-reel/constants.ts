// 実機調整前提: Loop Reel の操作感に関わる値はここへ集約する。
export const LOOP_REEL_TUNING = {
  replayMaxGapMs: 1800,
  catchUpMaxGapMs: 400,
  interventionMarkerThrottleMs: 5000,
  catchUpDefaultSpeed: 2,
  liveEdgeToleranceMs: 250,
  maskedLiveTailReloadDebounceMs: 500,
  liveTailStateCoalesceMs: 250,
  surfaceRetryMs: 250,
  refreshDebounceMs: 300,
  controlBarHeight: 46,
  markerSize: 9,
  playbackSpeeds: [1, 2, 4],
} as const;

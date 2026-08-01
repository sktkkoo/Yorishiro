import {
  createPerformanceCueResolverState,
  finishAssistantTranscript,
  type PerformanceCueResolverState,
  resolveAssistantTranscriptDelta,
} from "./resolver";
import {
  type PerformanceCueClock,
  PerformanceCueScheduler,
  type PerformanceCueSchedulerCallbacks,
  type PerformanceCueSchedulerOptions,
} from "./scheduler";

export interface RealtimePerformanceCueControllerOptions {
  readonly scheduler?: PerformanceCueSchedulerOptions;
  /** 無音がこの時間続いたら remote speech end とみなす。 */
  readonly silenceCompletionMs?: number;
}

const DEFAULT_SILENCE_COMPLETION_MS = 420;

/**
 * Codex realtime notification と remote audio activity を utterance 単位に束ねる。
 * transcript は読み取り専用で扱い、spoken text 自体は一切変更しない。
 */
export class RealtimePerformanceCueController {
  private readonly scheduler: PerformanceCueScheduler;
  private readonly silenceCompletionMs: number;
  private resolverState: PerformanceCueResolverState = createPerformanceCueResolverState();
  private utteranceSequence = 0;
  private utteranceId: string | null = null;
  private transcriptDone = false;
  private speechStartedAtMs: number | null = null;
  private lastSpeechSignalAtMs: number | null = null;
  private remoteSpeechActive = false;

  constructor(
    callbacks: PerformanceCueSchedulerCallbacks,
    options: RealtimePerformanceCueControllerOptions = {},
    private readonly clock: PerformanceCueClock = browserClock,
  ) {
    this.scheduler = new PerformanceCueScheduler(callbacks, options.scheduler, clock);
    this.silenceCompletionMs = nonNegative(
      options.silenceCompletionMs,
      DEFAULT_SILENCE_COMPLETION_MS,
    );
  }

  onTranscriptDelta(role: unknown, delta: unknown): void {
    if (role === "user") {
      // user の発話開始は barge-in として扱い、未再生 cue と所有 handle を即解放する。
      this.cancelAll();
      return;
    }
    if (role !== "assistant" || typeof delta !== "string" || delta.length === 0) return;

    const utteranceId = this.ensureAssistantUtterance();
    const resolution = resolveAssistantTranscriptDelta(this.resolverState, {
      utteranceId,
      delta,
      phase: this.remoteSpeechActive ? "assistant-speaking" : "assistant-responding",
    });
    this.resolverState = resolution.state;
    for (const cue of resolution.cues) this.scheduler.schedule(cue);
  }

  onTranscriptDone(role: unknown): void {
    if (role !== "assistant" || !this.utteranceId) return;
    const resolution = finishAssistantTranscript(this.resolverState, {
      utteranceId: this.utteranceId,
      phase: this.remoteSpeechActive ? "assistant-speaking" : "assistant-responding",
    });
    this.resolverState = resolution.state;
    for (const cue of resolution.cues) this.scheduler.schedule(cue);
    this.transcriptDone = true;

    // audio end が transcript/done より先に観測される順序も許容する。
    if (this.speechStartedAtMs !== null && !this.remoteSpeechActive) this.completeCurrent();
  }

  /** Body の lip-sync sample と同じ render clock から remote speech activity を受け取る。 */
  observeRemoteSpeech(hasSignal: boolean): void {
    const nowMs = this.clock.now();
    if (hasSignal) {
      this.lastSpeechSignalAtMs = nowMs;
      if (!this.remoteSpeechActive) {
        this.remoteSpeechActive = true;
        this.speechStartedAtMs = nowMs;
        if (this.utteranceId) this.scheduler.startUtterance(this.utteranceId, nowMs);
      }
      return;
    }

    if (
      !this.remoteSpeechActive ||
      this.lastSpeechSignalAtMs === null ||
      nowMs - this.lastSpeechSignalAtMs < this.silenceCompletionMs
    ) {
      return;
    }
    this.remoteSpeechActive = false;
    if (this.transcriptDone) this.completeCurrent();
  }

  cancelAll(): void {
    this.scheduler.cancelAll();
    this.resetUtterance();
  }

  private ensureAssistantUtterance(): string {
    if (this.utteranceId && !this.transcriptDone) return this.utteranceId;

    if (this.utteranceId) this.scheduler.cancelUtterance(this.utteranceId);
    const utteranceId = `realtime-${++this.utteranceSequence}`;
    this.utteranceId = utteranceId;
    this.transcriptDone = false;
    this.resolverState = createPerformanceCueResolverState();
    this.scheduler.prepareUtterance(utteranceId);
    if (this.remoteSpeechActive) {
      // 前の発話との無音境界を検出できなかった場合は、新しい transcript の到着時刻を
      // 新しい節の anchor にする。古い発話の start 時刻を流用しない。
      this.speechStartedAtMs = this.clock.now();
      this.scheduler.startUtterance(utteranceId, this.speechStartedAtMs);
    }
    return utteranceId;
  }

  private completeCurrent(): void {
    const utteranceId = this.utteranceId;
    if (utteranceId) this.scheduler.completeUtterance(utteranceId);
    this.resetUtterance();
  }

  private resetUtterance(): void {
    this.utteranceId = null;
    this.transcriptDone = false;
    this.resolverState = createPerformanceCueResolverState();
    this.speechStartedAtMs = null;
    this.lastSpeechSignalAtMs = null;
    this.remoteSpeechActive = false;
  }
}

const browserClock: PerformanceCueClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

function nonNegative(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

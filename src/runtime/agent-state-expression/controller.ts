import {
  createStateExpressionResolverState,
  finishAssistantTranscript,
  resolveAssistantTranscriptDelta,
  type StateExpressionResolverState,
} from "./resolver";
import {
  type StateExpressionClock,
  StateExpressionScheduler,
  type StateExpressionSchedulerCallbacks,
  type StateExpressionSchedulerOptions,
} from "./scheduler";

export interface RealtimeStateExpressionControllerOptions {
  readonly scheduler?: StateExpressionSchedulerOptions;
  /** 無音がこの時間続いたら remote speech end とみなす。 */
  readonly silenceCompletionMs?: number;
}

const DEFAULT_SILENCE_COMPLETION_MS = 420;

/**
 * Codex realtime notification と remote audio activity を utterance 単位に束ねる。
 * transcript は読み取り専用で扱い、spoken text 自体は一切変更しない。
 */
export class RealtimeStateExpressionController {
  private readonly scheduler: StateExpressionScheduler;
  private readonly silenceCompletionMs: number;
  private resolverState: StateExpressionResolverState = createStateExpressionResolverState();
  private utteranceSequence = 0;
  private utteranceId: string | null = null;
  private transcriptDone = false;
  private utteranceSpeechStarted = false;
  private speechStartedAtMs: number | null = null;
  private lastSpeechSignalAtMs: number | null = null;
  private remoteSpeechActive = false;
  private speechAnchorClaimed = false;
  private interruptionPending = false;
  private interruptedUserTranscriptDone = false;
  private remoteSilenceObservedAfterInterruption = false;

  constructor(
    callbacks: StateExpressionSchedulerCallbacks,
    options: RealtimeStateExpressionControllerOptions = {},
    private readonly clock: StateExpressionClock = browserClock,
  ) {
    this.scheduler = new StateExpressionScheduler(callbacks, options.scheduler, clock);
    this.silenceCompletionMs = nonNegative(
      options.silenceCompletionMs,
      DEFAULT_SILENCE_COMPLETION_MS,
    );
  }

  onTranscriptDelta(role: unknown, delta: unknown): void {
    if (role === "user") {
      this.beginUserInterruption();
      return;
    }
    if (role !== "assistant" || typeof delta !== "string" || delta.length === 0) return;
    if (this.interruptionPending) return;

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
    if (role === "user") {
      this.finishUserInterruptionTranscript();
      return;
    }
    if (this.interruptionPending) return;
    if (role !== "assistant" || !this.utteranceId) return;
    const resolution = finishAssistantTranscript(this.resolverState, {
      utteranceId: this.utteranceId,
      phase: this.remoteSpeechActive ? "assistant-speaking" : "assistant-responding",
    });
    this.resolverState = resolution.state;
    for (const cue of resolution.cues) this.scheduler.schedule(cue);
    this.transcriptDone = true;

    // audio end が transcript/done より先に観測される順序も許容する。
    if (this.utteranceSpeechStarted && !this.remoteSpeechActive) this.completeCurrent();
  }

  /** Receives remote speech activity from the client-owned audio sampling loop. */
  observeRemoteSpeech(hasSignal: boolean): void {
    const nowMs = this.clock.now();
    if (hasSignal) {
      this.lastSpeechSignalAtMs = nowMs;
      if (!this.remoteSpeechActive) {
        this.remoteSpeechActive = true;
        this.speechStartedAtMs = nowMs;
        this.speechAnchorClaimed = false;
        if (this.utteranceId && !this.interruptionPending) {
          this.scheduler.startUtterance(this.utteranceId, nowMs);
          this.utteranceSpeechStarted = true;
          this.speechAnchorClaimed = true;
        }
      }
      return;
    }

    if (!this.remoteSpeechActive) {
      if (this.interruptionPending && this.lastSpeechSignalAtMs === null) {
        this.remoteSilenceObservedAfterInterruption = true;
        this.finishInterruptionIfReady();
      }
      return;
    }

    if (
      this.lastSpeechSignalAtMs === null ||
      nowMs - this.lastSpeechSignalAtMs < this.silenceCompletionMs
    ) {
      return;
    }
    this.remoteSpeechActive = false;
    this.speechStartedAtMs = null;
    this.lastSpeechSignalAtMs = null;
    this.speechAnchorClaimed = false;
    if (this.interruptionPending) {
      this.remoteSilenceObservedAfterInterruption = true;
      this.finishInterruptionIfReady();
    }
    if (this.transcriptDone) this.completeCurrent();
  }

  cancelAll(): void {
    this.scheduler.cancelAll();
    this.resetUtterance();
    this.resetRemoteSpeech();
    this.resetInterruption();
  }

  private ensureAssistantUtterance(): string {
    if (this.utteranceId && !this.transcriptDone) return this.utteranceId;

    if (this.utteranceId) this.scheduler.cancelUtterance(this.utteranceId);
    const utteranceId = `realtime-${++this.utteranceSequence}`;
    this.utteranceId = utteranceId;
    this.transcriptDone = false;
    this.resolverState = createStateExpressionResolverState();
    this.scheduler.prepareUtterance(utteranceId);
    if (this.remoteSpeechActive) {
      const speechStartedAtMs =
        !this.speechAnchorClaimed && this.speechStartedAtMs !== null
          ? this.speechStartedAtMs
          : this.clock.now();
      this.scheduler.startUtterance(utteranceId, speechStartedAtMs);
      this.utteranceSpeechStarted = true;
      this.speechAnchorClaimed = true;
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
    this.utteranceSpeechStarted = false;
    this.resolverState = createStateExpressionResolverState();
  }

  private resetRemoteSpeech(): void {
    this.speechStartedAtMs = null;
    this.lastSpeechSignalAtMs = null;
    this.remoteSpeechActive = false;
    this.speechAnchorClaimed = false;
  }

  private beginUserInterruption(): void {
    if (this.interruptionPending) return;
    this.interruptionPending = true;
    this.interruptedUserTranscriptDone = false;
    this.remoteSilenceObservedAfterInterruption = false;
    this.scheduler.cancelAll();
    this.resetUtterance();
  }

  private finishUserInterruptionTranscript(): void {
    if (!this.interruptionPending) this.beginUserInterruption();
    this.interruptedUserTranscriptDone = true;
    this.finishInterruptionIfReady();
  }

  private finishInterruptionIfReady(): void {
    if (!this.interruptedUserTranscriptDone || !this.remoteSilenceObservedAfterInterruption) return;
    this.resetInterruption();
  }

  private resetInterruption(): void {
    this.interruptionPending = false;
    this.interruptedUserTranscriptDone = false;
    this.remoteSilenceObservedAfterInterruption = false;
  }
}

const browserClock: StateExpressionClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

function nonNegative(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

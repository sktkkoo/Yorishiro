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
  /** Silence needed to classify a waveform gap as a resumable pause. */
  readonly silenceCompletionMs?: number;
  /** Quiet time after transcript completion before response-owned cues are released. */
  readonly responseCompletionSilenceMs?: number;
  /** Maximum age of a completed audio interval that a late transcript may bind to. */
  readonly audioAnchorRetentionMs?: number;
}

const DEFAULT_SILENCE_COMPLETION_MS = 420;
const DEFAULT_RESPONSE_COMPLETION_SILENCE_MS = 1_500;
const DEFAULT_AUDIO_ANCHOR_RETENTION_MS = 2_500;

/**
 * Codex realtime notification と remote audio activity を utterance 単位に束ねる。
 * transcript は読み取り専用で扱い、spoken text 自体は一切変更しない。
 */
export class RealtimeStateExpressionController {
  private readonly scheduler: StateExpressionScheduler;
  private readonly silenceCompletionMs: number;
  private readonly responseCompletionSilenceMs: number;
  private readonly audioAnchorRetentionMs: number;
  private resolverState: StateExpressionResolverState = createStateExpressionResolverState();
  private utteranceSequence = 0;
  private responseGeneration = 0;
  private utteranceId: string | null = null;
  private transcriptDone = false;
  private utteranceSpeechStarted = false;
  private speechStartedAtMs: number | null = null;
  private lastSpeechSignalAtMs: number | null = null;
  private remoteSpeechActive = false;
  private speechAnchorClaimed = false;
  private audioGeneration: number | null = null;
  private audioItemId: string | null = null;
  private pendingAudioGeneration: number | null = null;
  private pendingAudioItemId: string | null = null;
  private responsePhase: "open" | "user-speaking" | "awaiting-assistant" = "open";
  private userTranscriptPending = false;
  private itemBoundaryMode = false;
  private assistantBoundaryAccepted = true;
  private responseItemId: string | null = null;
  private readonly invalidatedItemIds = new Set<string>();
  private completionTimer: unknown | null = null;

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
    this.responseCompletionSilenceMs = nonNegative(
      options.responseCompletionSilenceMs,
      DEFAULT_RESPONSE_COMPLETION_SILENCE_MS,
    );
    this.audioAnchorRetentionMs = nonNegative(
      options.audioAnchorRetentionMs,
      DEFAULT_AUDIO_ANCHOR_RETENTION_MS,
    );
  }

  /** Starts a new user-owned generation from an authoritative transport speech boundary. */
  onUserSpeechStarted(itemId?: unknown): void {
    this.beginUserInterruption(typeof itemId === "string" ? itemId : null);
  }

  /** Associates flat transcript notifications with a provider response item when available. */
  onAssistantResponseBoundary(itemId: unknown): boolean {
    if (typeof itemId !== "string" || itemId.length === 0) return false;
    this.itemBoundaryMode = true;
    if (this.invalidatedItemIds.has(itemId)) {
      // A stale boundary can arrive after a newer response item was already accepted.
      // It must not revoke ownership from that distinct current response.
      if (
        this.assistantBoundaryAccepted &&
        this.responseItemId !== null &&
        this.responseItemId !== itemId
      ) {
        return false;
      }
      this.assistantBoundaryAccepted = false;
      this.responseItemId = null;
      return false;
    }
    if (this.responsePhase === "user-speaking") this.responsePhase = "open";
    this.responseItemId = itemId;
    this.assistantBoundaryAccepted = true;
    return true;
  }

  /** Uses output-audio item identity as an authoritative response/audio boundary. */
  onOutputAudioItem(itemId: unknown): void {
    if (typeof itemId !== "string" || itemId.length === 0) return;
    if (!this.onAssistantResponseBoundary(itemId)) return;
    if (this.remoteSpeechActive && this.audioGeneration === this.responseGeneration) {
      this.audioItemId = itemId;
      return;
    }
    this.pendingAudioGeneration = this.responseGeneration;
    this.pendingAudioItemId = itemId;
  }

  onTranscriptDelta(role: unknown, delta: unknown): void {
    if (role === "user") {
      if (!this.userTranscriptPending) this.beginUserInterruption(null);
      return;
    }
    if (role !== "assistant" || typeof delta !== "string" || delta.length === 0) return;
    if (this.responsePhase === "user-speaking") return;
    if (this.itemBoundaryMode && !this.assistantBoundaryAccepted) return;
    this.responsePhase = "open";

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
      this.finishUserTranscript();
      return;
    }
    if (this.responsePhase === "user-speaking") return;
    if (this.itemBoundaryMode && !this.assistantBoundaryAccepted) return;
    if (role !== "assistant" || !this.utteranceId) return;
    const resolution = finishAssistantTranscript(this.resolverState, {
      utteranceId: this.utteranceId,
      phase: this.remoteSpeechActive ? "assistant-speaking" : "assistant-responding",
    });
    this.resolverState = resolution.state;
    for (const cue of resolution.cues) this.scheduler.schedule(cue);
    this.transcriptDone = true;
    this.scheduleCompletionIfQuiet();
  }

  /** Receives remote speech activity from the client-owned audio sampling loop. */
  observeRemoteSpeech(hasSignal: boolean): void {
    const nowMs = this.clock.now();
    if (hasSignal) {
      this.cancelCompletionTimer();
      const previousSignalAtMs = this.lastSpeechSignalAtMs;
      this.lastSpeechSignalAtMs = nowMs;
      // An interrupted response and its replacement can have no measurable silence
      // between them. Pending metadata from the current generation must still move
      // the playout anchor away from the older generation.
      if (
        this.pendingAudioGeneration === this.responseGeneration &&
        this.audioGeneration !== this.responseGeneration
      ) {
        const itemId = this.pendingAudioItemId ?? this.responseItemId;
        this.remoteSpeechActive = true;
        this.claimAudioAnchor(nowMs, itemId);
        this.pendingAudioGeneration = null;
        this.pendingAudioItemId = null;
        return;
      }
      if (!this.remoteSpeechActive) {
        this.remoteSpeechActive = true;
        if (
          this.audioGeneration !== this.responseGeneration ||
          this.speechStartedAtMs === null ||
          (previousSignalAtMs !== null && nowMs - previousSignalAtMs > this.audioAnchorRetentionMs)
        ) {
          const itemId =
            this.pendingAudioGeneration === this.responseGeneration
              ? this.pendingAudioItemId
              : this.responseItemId;
          this.claimAudioAnchor(nowMs, itemId);
          this.pendingAudioGeneration = null;
          this.pendingAudioItemId = null;
        } else {
          this.bindCurrentUtteranceToAudio();
        }
      }
      return;
    }

    if (!this.remoteSpeechActive) return;

    if (
      this.lastSpeechSignalAtMs === null ||
      nowMs - this.lastSpeechSignalAtMs < this.silenceCompletionMs
    ) {
      return;
    }
    this.remoteSpeechActive = false;
    if (this.audioGeneration !== this.responseGeneration) {
      this.resetRemoteSpeech();
      return;
    }
    this.scheduleCompletionIfQuiet();
  }

  cancelAll(): void {
    this.scheduler.cancelAll();
    this.cancelCompletionTimer();
    this.resetUtterance();
    this.resetRemoteSpeech();
    this.responsePhase = "open";
    this.userTranscriptPending = false;
    this.assistantBoundaryAccepted = !this.itemBoundaryMode;
    this.responseItemId = null;
    this.pendingAudioGeneration = null;
    this.pendingAudioItemId = null;
  }

  private ensureAssistantUtterance(): string {
    if (this.utteranceId && !this.transcriptDone) return this.utteranceId;

    if (this.utteranceId) this.scheduler.cancelUtterance(this.utteranceId);
    const utteranceId = `realtime-${++this.utteranceSequence}`;
    this.utteranceId = utteranceId;
    this.transcriptDone = false;
    this.resolverState = createStateExpressionResolverState();
    this.scheduler.prepareUtterance(utteranceId);
    if (this.hasRetainedAudioAnchor()) {
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
    this.cancelCompletionTimer();
    const utteranceId = this.utteranceId;
    if (utteranceId) this.scheduler.completeUtterance(utteranceId);
    this.resetUtterance();
    if (!this.remoteSpeechActive && this.audioGeneration === this.responseGeneration) {
      this.resetRemoteSpeech();
    }
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
    this.audioGeneration = null;
    this.audioItemId = null;
  }

  private beginUserInterruption(_itemId: string | null): void {
    if (this.userTranscriptPending) return;
    this.responseGeneration++;
    this.responsePhase = "user-speaking";
    this.userTranscriptPending = true;
    this.cancelCompletionTimer();
    if (this.responseItemId) this.invalidatedItemIds.add(this.responseItemId);
    if (this.audioItemId) this.invalidatedItemIds.add(this.audioItemId);
    if (this.pendingAudioItemId) this.invalidatedItemIds.add(this.pendingAudioItemId);
    this.pendingAudioGeneration = null;
    this.pendingAudioItemId = null;
    this.responseItemId = null;
    this.assistantBoundaryAccepted = !this.itemBoundaryMode;
    this.scheduler.cancelAll();
    this.resetUtterance();
  }

  private finishUserTranscript(): void {
    if (!this.userTranscriptPending) this.beginUserInterruption(null);
    this.userTranscriptPending = false;
    if (this.responsePhase === "user-speaking") this.responsePhase = "awaiting-assistant";
  }

  private claimAudioAnchor(startedAtMs: number, itemId: string | null): void {
    this.speechStartedAtMs = startedAtMs;
    this.lastSpeechSignalAtMs = startedAtMs;
    this.speechAnchorClaimed = false;
    this.audioGeneration = this.responseGeneration;
    this.audioItemId = itemId;
    this.bindCurrentUtteranceToAudio();
  }

  private bindCurrentUtteranceToAudio(): void {
    if (
      !this.utteranceId ||
      this.speechAnchorClaimed ||
      this.audioGeneration !== this.responseGeneration ||
      this.speechStartedAtMs === null
    ) {
      return;
    }
    this.scheduler.startUtterance(this.utteranceId, this.speechStartedAtMs);
    this.utteranceSpeechStarted = true;
    this.speechAnchorClaimed = true;
  }

  private hasRetainedAudioAnchor(): boolean {
    if (
      this.audioGeneration !== this.responseGeneration ||
      this.speechStartedAtMs === null ||
      this.lastSpeechSignalAtMs === null
    ) {
      return false;
    }
    return this.clock.now() - this.lastSpeechSignalAtMs <= this.audioAnchorRetentionMs;
  }

  private scheduleCompletionIfQuiet(): void {
    if (!this.transcriptDone || this.remoteSpeechActive || !this.utteranceSpeechStarted) return;
    const lastSignalAtMs = this.lastSpeechSignalAtMs;
    if (lastSignalAtMs === null) return;
    this.cancelCompletionTimer();
    const generation = this.responseGeneration;
    const delayMs = Math.max(
      0,
      this.responseCompletionSilenceMs - (this.clock.now() - lastSignalAtMs),
    );
    this.completionTimer = this.clock.setTimeout(() => {
      this.completionTimer = null;
      if (
        generation !== this.responseGeneration ||
        this.remoteSpeechActive ||
        !this.transcriptDone
      ) {
        return;
      }
      this.completeCurrent();
    }, delayMs);
  }

  private cancelCompletionTimer(): void {
    if (this.completionTimer === null) return;
    this.clock.clearTimeout(this.completionTimer);
    this.completionTimer = null;
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

import {
  DEFAULT_MOTION_CATALOG,
  type MotionCandidate,
  type MotionCatalogEntry,
  type MotionContext,
  type MotionHistoryEntry,
  type MotionIntent,
  retrieveMotionCandidates,
  type SemanticMotionQuery,
  sampleMotionCandidate,
} from "./motion-catalog";

export interface DirectedMotionOptions {
  readonly loop: boolean;
  readonly weight: number;
  readonly speed: number;
  readonly fadeInMs: number;
  readonly fadeOutMs: number;
  readonly transition: "matched" | "immediate";
  readonly mask: "upper-body";
  /** Mechanically compatible entry chosen before the weighted draw. */
  readonly startTimeSec?: number;
  /** Finite speech motifs may retire near a quiet exit before a long recording ends. */
  readonly maxDurationMs?: number;
}

export interface MotionDecision {
  readonly animation: string;
  readonly options: DirectedMotionOptions;
  readonly intent: MotionIntent;
  readonly context: MotionContext;
  readonly selectedAtMs: number;
  readonly nextDueAtMs: number;
  readonly reason: "idle-dwell-elapsed" | "speech-dwell-elapsed" | "speech-intent";
  readonly candidates: readonly DirectedMotionCandidate[];
  readonly finishAfterSpeech?: true;
}

export interface MotionTransitionEvaluation {
  readonly cost: number;
  readonly startTimeSec: number;
}

export interface DirectedMotionCandidate extends MotionCandidate {
  readonly transition?: MotionTransitionEvaluation;
}

export interface MotionDirectorOptions {
  readonly random?: () => number;
  readonly catalog?: readonly MotionCatalogEntry[];
  readonly availableAnimations?: ReadonlySet<string>;
  readonly initialDelayMs?: number;
  /** Cache-only target-pose evaluation. Null keeps an incompatible/cold clip out of the draw. */
  readonly evaluateTransition?: (
    animation: string,
    options: DirectedMotionOptions,
  ) => MotionTransitionEvaluation | null;
}

export interface MotionDirectorContext {
  readonly enabled: boolean;
  readonly context: MotionContext;
  readonly intent?: MotionIntent;
  /** Higher-priority motion, body ownership, or user interaction is active. */
  readonly blocked?: boolean;
}

export interface MotionDirectorSnapshot {
  readonly elapsedMs: number;
  readonly nextDueAtMs: number;
  readonly quietUntilMs: number;
  readonly phase: "waiting" | "dwelling" | "quiet" | "blocked" | "disabled";
  readonly lastDecision: MotionDecision | null;
  readonly history: readonly MotionHistoryEntry[];
  readonly suppressedReason:
    | "disabled"
    | "priority"
    | "dwell"
    | "quiet"
    | "cooldown"
    | "transition"
    | null;
}

/**
 * Stateful timing over a pure semantic index. It schedules motifs, not frames.
 * The Body scheduler still owns priority/preemption and the player owns seams.
 * Quiet periods keep the current idle clip: they do not snap back to a rest pose.
 */
export class MotionDirector {
  private elapsedMs = 0;
  private nextDueAtMs: number;
  private quietUntilMs = 0;
  private retryAtMs = 0;
  private lastSpeechAtMs = -Infinity;
  private phase: MotionDirectorSnapshot["phase"] = "waiting";
  private suppressedReason: MotionDirectorSnapshot["suppressedReason"] = null;
  private history: MotionHistoryEntry[] = [];
  private lastDecision: MotionDecision | null = null;
  private readonly random: () => number;

  constructor(private readonly options: MotionDirectorOptions = {}) {
    this.random = options.random ?? Math.random;
    this.nextDueAtMs = Math.max(0, options.initialDelayMs ?? 1_200);
  }

  update(deltaMs: number, context: MotionDirectorContext): MotionDecision | null {
    // Resuming after suspension must not run a backlog of random gestures.
    if (Number.isFinite(deltaMs)) this.elapsedMs += Math.max(0, Math.min(deltaMs, 1_000));
    if (!context.enabled) {
      this.phase = "disabled";
      this.suppressedReason = "disabled";
      this.nextDueAtMs = Math.max(this.nextDueAtMs, this.elapsedMs + 1_200);
      return null;
    }
    const speechBaseline = context.context === "speech" && context.intent === "explain";
    if (context.blocked || (context.context !== "idle" && !speechBaseline)) {
      this.phase = "blocked";
      this.suppressedReason = "priority";
      // A short settling period makes the handoff back to ambient deliberate.
      this.nextDueAtMs = Math.max(this.nextDueAtMs, this.elapsedMs + 2_500);
      return null;
    }
    if (this.elapsedMs >= this.nextDueAtMs && this.elapsedMs < this.quietUntilMs) {
      this.phase = "quiet";
      this.suppressedReason = "quiet";
      return null;
    }
    if (this.elapsedMs < this.nextDueAtMs) {
      this.phase = this.lastDecision ? "dwelling" : "waiting";
      this.suppressedReason = this.elapsedMs < this.retryAtMs ? "cooldown" : "dwell";
      return null;
    }
    return this.select(
      { intent: context.intent ?? "neutral", context: context.context },
      speechBaseline ? "speech-dwell-elapsed" : "idle-dwell-elapsed",
    );
  }

  /** Grounded speech intent works without inline tags or an additional LLM. */
  request(
    query: SemanticMotionQuery,
    options?: { readonly preferredAnimation?: string },
  ): MotionDecision | null {
    if (query.context === "speech" && this.elapsedMs - this.lastSpeechAtMs < 2_400) {
      this.suppressedReason = "quiet";
      return null;
    }
    return this.select(
      query,
      query.context === "speech" ? "speech-intent" : "idle-dwell-elapsed",
      options?.preferredAnimation,
    );
  }

  getSnapshot(): MotionDirectorSnapshot {
    return {
      elapsedMs: this.elapsedMs,
      nextDueAtMs: this.nextDueAtMs,
      quietUntilMs: this.quietUntilMs,
      phase: this.phase,
      lastDecision: this.lastDecision,
      history: this.history.map((entry) => ({ ...entry })),
      suppressedReason: this.suppressedReason,
    };
  }

  /** Reconsider a changed conversation state without bypassing ownership or history. */
  requestNextIdle(delayMs = 600): void {
    const delay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 600;
    this.nextDueAtMs = Math.min(this.nextDueAtMs, this.elapsedMs + delay);
    this.quietUntilMs = 0;
    this.retryAtMs = 0;
  }

  /** A failed or missing asset must not be retried on every animation frame. */
  excludeAnimation(animation: string): void {
    this.excludedAnimations.add(animation);
  }

  private readonly excludedAnimations = new Set<string>();

  private select(
    query: SemanticMotionQuery,
    reason: MotionDecision["reason"],
    preferredAnimation?: string,
  ): MotionDecision | null {
    const semanticCandidates = retrieveMotionCandidates(query, {
      nowMs: this.elapsedMs,
      history: this.history,
      catalog: (this.options.catalog ?? DEFAULT_MOTION_CATALOG).filter(
        (entry) =>
          !this.excludedAnimations.has(entry.animation) &&
          !(reason === "speech-dwell-elapsed" && entry.playback === "once"),
      ),
      availableAnimations: this.options.availableAnimations,
      // Apply the physical gate before the final top five: a bad seam must not
      // crowd a compatible, slightly lower semantic match out of consideration.
      includeAllEligible: this.options.evaluateTransition !== undefined,
    });
    const candidates: DirectedMotionCandidate[] = [];
    for (const candidate of semanticCandidates) {
      if (!this.options.evaluateTransition) {
        candidates.push(candidate);
        continue;
      }
      const playbackOptions = this.playbackOptions(candidate, query, reason);
      const transition = this.options.evaluateTransition(candidate.animation, playbackOptions);
      if (
        !transition ||
        !Number.isFinite(transition.cost) ||
        transition.cost < 0 ||
        !Number.isFinite(transition.startTimeSec) ||
        transition.startTimeSec < 0 ||
        (!playbackOptions.loop && transition.startTimeSec !== 0)
      )
        continue;
      candidates.push({
        ...candidate,
        weight: candidate.weight * Math.exp(-4 * transition.cost),
        transition,
      });
    }
    if (this.options.evaluateTransition) {
      candidates.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
    }
    // A preferred first posture still has to pass semantic, history and physical
    // gates. When it cannot, keep the ordinary weighted choice of safe candidates.
    const preferredIndex = candidates.findIndex((entry) => entry.animation === preferredAnimation);
    if (preferredIndex > 0) candidates.unshift(...candidates.splice(preferredIndex, 1));
    candidates.splice(5);
    const selected = sampleMotionCandidate(
      preferredIndex >= 0 ? candidates.slice(0, 1) : candidates,
      this.random,
    );
    if (!selected) {
      this.suppressedReason = semanticCandidates.length > 0 ? "transition" : "cooldown";
      this.nextDueAtMs = Math.max(this.nextDueAtMs, this.elapsedMs + 2_500);
      this.retryAtMs = this.nextDueAtMs;
      return null;
    }
    const speech = query.context === "speech";
    const speechBaseline = reason === "speech-dwell-elapsed";
    const finiteGesture = speech && !speechBaseline;
    // A short finite gesture must not leave the body without a recorded idle
    // for an entire 12–25 second ambient dwell after the utterance ends.
    // While a higher-priority gesture remains active, Body extends this handoff.
    const dwellMs = finiteGesture
      ? 2_500
      : speechBaseline
        ? 10_000 + this.unitRandom() * 8_000
        : 12_000 + this.unitRandom() * 13_000;
    // Occasional extra stillness prevents metronomic switching, without stopping
    // the current loop. Conversational background uses a slightly shorter dwell.
    const quietMs =
      !finiteGesture && this.unitRandom() < 0.2 ? 1_000 + this.unitRandom() * 2_000 : 0;
    this.nextDueAtMs = this.elapsedMs + dwellMs;
    this.quietUntilMs = quietMs > 0 ? this.nextDueAtMs + quietMs : 0;
    // Background conversation must never consume a grounded gesture's cooldown.
    if (finiteGesture) this.lastSpeechAtMs = this.elapsedMs;
    const decision: MotionDecision = {
      animation: selected.animation,
      options: {
        ...this.playbackOptions(selected, query, reason),
        ...(selected.transition ? { startTimeSec: selected.transition.startTimeSec } : {}),
      },
      intent: query.intent,
      context: query.context,
      selectedAtMs: this.elapsedMs,
      nextDueAtMs: this.nextDueAtMs,
      reason,
      candidates,
      ...(finiteGesture && selected.entry.playback === "once" && selected.entry.finishAfterSpeech
        ? { finishAfterSpeech: true as const }
        : {}),
    };
    this.history.push({
      id: selected.id,
      family: selected.entry.family,
      context: query.context,
      selectedAtMs: this.elapsedMs,
    });
    this.history = this.history.filter((entry) => this.elapsedMs - entry.selectedAtMs <= 180_000);
    this.lastDecision = decision;
    this.retryAtMs = 0;
    this.phase = "dwelling";
    this.suppressedReason = null;
    return decision;
  }

  private playbackOptions(
    candidate: MotionCandidate,
    query: SemanticMotionQuery,
    reason: MotionDecision["reason"],
  ): DirectedMotionOptions {
    const speechBaseline = reason === "speech-dwell-elapsed";
    const finiteGesture = query.context === "speech" && !speechBaseline;
    const reviewedOnce = candidate.entry.playback === "once";
    const finiteMotion = finiteGesture || reviewedOnce;
    const maxDurationMs =
      candidate.entry.maxDurationMs ?? (finiteGesture && !reviewedOnce ? 6_000 : undefined);
    const intensity = Number.isFinite(query.intensity)
      ? Math.max(0, Math.min(1, query.intensity ?? 0.5))
      : 0.5;
    return {
      loop: !finiteMotion,
      weight: speechBaseline
        ? candidate.entry.weight
        : Math.min(1, candidate.entry.weight * (0.65 + intensity * 0.7)),
      speed: candidate.entry.speed,
      fadeInMs: finiteMotion ? 420 : 1_200,
      fadeOutMs: finiteMotion ? 600 : 1_200,
      transition: finiteMotion ? "immediate" : "matched",
      mask: "upper-body",
      ...(finiteMotion && maxDurationMs !== undefined ? { maxDurationMs } : {}),
    };
  }

  private unitRandom(): number {
    const value = this.random();
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
  }
}

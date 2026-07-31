import type { PerformanceCue } from "./types";

export type PerformanceCueReleaseReason = "completed" | "cancelled" | "replaced";

type TimerHandle = unknown;

export interface PerformanceCueClock {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  readonly clearTimeout: (handle: TimerHandle) => void;
}

export interface PerformanceCueDispatchContext {
  readonly scheduledForMs: number;
  readonly firedAtMs: number;
  readonly lateByMs: number;
}

export interface PerformanceCueSchedulerCallbacks {
  /** semantic cue を persona / avatar / motion catalog に解決する integration point。 */
  readonly onCue: (cue: PerformanceCue, context: PerformanceCueDispatchContext) => void;
  /** voice stop 等で、この発話が所有する expression / gesture handle を解放する。 */
  readonly onRelease: (utteranceId: string, reason: PerformanceCueReleaseReason) => void;
}

export interface PerformanceCueSchedulerOptions {
  /** この値より遅く届いた cue は再生しない。 */
  readonly maxLateMs?: number;
  /** cue 全体の最短間隔。遅着 cue の一斉発火もここで抑える。 */
  readonly cueCooldownMs?: number;
  /** body gesture の最短間隔。表情だけは残せる。 */
  readonly gestureCooldownMs?: number;
}

export type PerformanceCueScheduleResult =
  | { readonly status: "queued" }
  | { readonly status: "scheduled"; readonly scheduledForMs: number }
  | { readonly status: "clamped"; readonly scheduledForMs: number; readonly lateByMs: number }
  | {
      readonly status: "skipped";
      readonly reason: "unknown-utterance" | "late" | "duplicate";
    };

interface ActiveUtterance {
  readonly id: string;
  speechStartedAtMs: number | null;
  readonly timers: Map<string, TimerHandle>;
  readonly cueKeys: Set<string>;
  readonly queuedCues: Map<string, PerformanceCue>;
}

const DEFAULT_MAX_LATE_MS = 450;
const DEFAULT_CUE_COOLDOWN_MS = 800;
const DEFAULT_GESTURE_COOLDOWN_MS = 2_200;

const systemClock: PerformanceCueClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

/**
 * remote speech clock に semantic cue を載せる utterance 単位 scheduler。
 * Clock と dispatch は注入可能で、Web Audio / Body runtime には直接依存しない。
 */
export class PerformanceCueScheduler {
  private readonly maxLateMs: number;
  private readonly cueCooldownMs: number;
  private readonly gestureCooldownMs: number;
  private active: ActiveUtterance | null = null;
  private lastCueAtMs = Number.NEGATIVE_INFINITY;
  private lastGestureAtMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly callbacks: PerformanceCueSchedulerCallbacks,
    options: PerformanceCueSchedulerOptions = {},
    private readonly clock: PerformanceCueClock = systemClock,
  ) {
    this.maxLateMs = nonNegative(options.maxLateMs, DEFAULT_MAX_LATE_MS);
    this.cueCooldownMs = nonNegative(options.cueCooldownMs, DEFAULT_CUE_COOLDOWN_MS);
    this.gestureCooldownMs = nonNegative(options.gestureCooldownMs, DEFAULT_GESTURE_COOLDOWN_MS);
  }

  /** transcript が audio より先に届く場合の cue queue を用意する。 */
  prepareUtterance(utteranceId: string): void {
    if (this.active?.id === utteranceId) return;
    if (this.active) this.releaseActive("replaced");
    this.active = {
      id: utteranceId,
      speechStartedAtMs: null,
      timers: new Map(),
      cueKeys: new Set(),
      queuedCues: new Map(),
    };
  }

  /** analyser が検出した remote speech start の clock 値を登録し、先着 cue を schedule する。 */
  startUtterance(utteranceId: string, speechStartedAtMs: number = this.clock.now()): void {
    this.prepareUtterance(utteranceId);
    const active = this.active;
    if (!active || active.speechStartedAtMs !== null) return;
    active.speechStartedAtMs = speechStartedAtMs;
    for (const [key, cue] of active.queuedCues) {
      this.scheduleStartedCue(active, key, cue);
    }
    active.queuedCues.clear();
  }

  schedule(cue: PerformanceCue): PerformanceCueScheduleResult {
    const active = this.active;
    if (!active || active.id !== cue.utteranceId) {
      return { status: "skipped", reason: "unknown-utterance" };
    }

    const key = cueKey(cue);
    if (active.cueKeys.has(key)) {
      return { status: "skipped", reason: "duplicate" };
    }
    active.cueKeys.add(key);

    if (active.speechStartedAtMs === null) {
      active.queuedCues.set(key, cue);
      return { status: "queued" };
    }

    return this.scheduleStartedCue(active, key, cue);
  }

  private scheduleStartedCue(
    active: ActiveUtterance,
    key: string,
    cue: PerformanceCue,
  ): PerformanceCueScheduleResult {
    const speechStartedAtMs = active.speechStartedAtMs;
    if (speechStartedAtMs === null) return { status: "queued" };

    const relativeAtMs = Number.isFinite(cue.atMs) ? Math.max(0, cue.atMs) : 0;
    const scheduledForMs = speechStartedAtMs + relativeAtMs;
    const nowMs = this.clock.now();
    const lateByMs = nowMs - scheduledForMs;
    if (lateByMs > this.maxLateMs) {
      return { status: "skipped", reason: "late" };
    }

    const delayMs = Math.max(0, scheduledForMs - nowMs);
    const timer = this.clock.setTimeout(() => {
      active.timers.delete(key);
      if (this.active !== active) return;
      // schedule 後に main thread / event loop が詰まった場合も、過去分を遅れて
      // 再生しない。schedule 時と発火時の二段で lateness を判定する。
      if (this.clock.now() - scheduledForMs > this.maxLateMs) return;
      this.dispatchWithCooldown(cue, scheduledForMs);
    }, delayMs);
    active.timers.set(key, timer);

    return lateByMs > 0
      ? { status: "clamped", scheduledForMs, lateByMs }
      : { status: "scheduled", scheduledForMs };
  }

  /** remote audio の自然終了。未発火 cue は捨て、発話由来の演技を release する。 */
  completeUtterance(utteranceId: string): void {
    if (this.active?.id !== utteranceId) return;
    this.releaseActive("completed");
  }

  /** barge-in / voice stop / disconnect。未発火 cue と演技 handle を即座に解放する。 */
  cancelUtterance(utteranceId: string): void {
    if (this.active?.id !== utteranceId) return;
    this.releaseActive("cancelled");
  }

  cancelAll(): void {
    if (this.active) this.releaseActive("cancelled");
  }

  private dispatchWithCooldown(cue: PerformanceCue, scheduledForMs: number): void {
    const firedAtMs = this.clock.now();
    if (firedAtMs - this.lastCueAtMs < this.cueCooldownMs) return;

    let effectiveCue = cue;
    if (
      cue.gestureIntent &&
      cue.gestureIntent !== "none" &&
      firedAtMs - this.lastGestureAtMs < this.gestureCooldownMs
    ) {
      if (!cue.expression) return;
      effectiveCue = { ...cue, gestureIntent: "none" };
    }

    this.lastCueAtMs = firedAtMs;
    if (effectiveCue.gestureIntent && effectiveCue.gestureIntent !== "none") {
      this.lastGestureAtMs = firedAtMs;
    }
    this.callbacks.onCue(effectiveCue, {
      scheduledForMs,
      firedAtMs,
      lateByMs: Math.max(0, firedAtMs - scheduledForMs),
    });
  }

  private releaseActive(reason: PerformanceCueReleaseReason): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    for (const timer of active.timers.values()) this.clock.clearTimeout(timer);
    active.timers.clear();
    this.callbacks.onRelease(active.id, reason);
  }
}

function cueKey(cue: PerformanceCue): string {
  return [
    cue.atMs,
    cue.expression ?? "",
    cue.expressionWeight ?? "",
    cue.gestureIntent ?? "",
    cue.intensity ?? "",
    cue.durationMs ?? "",
  ].join("|");
}

function nonNegative(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

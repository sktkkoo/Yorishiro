import type { MotionHandle } from "./motion-scheduler";

export interface OccasionalIdleMotionOptions {
  /** Return null while the reviewed asset or its physical entry is unavailable. */
  readonly play: () => MotionHandle | null;
  readonly random?: () => number;
  /** Quiet, eligible time between performances. Injectable for deterministic checks. */
  readonly waitRangeMs?: readonly [number, number];
  /** Optional maximum ownership time for looping variations; finite recordings keep their natural end by default. */
  readonly activeDurationRangeMs?: readonly [number, number];
}

export interface OccasionalIdleMotionSnapshot {
  readonly eligible: boolean;
  readonly disposed: boolean;
  readonly waitRemainingMs: number;
  readonly retryRemainingMs: number;
  /** Includes a scheduler handle whose prepared recording has not started yet. */
  readonly activeAnimation: string | null;
  readonly activeRemainingMs: number | null;
}

/**
 * A rare, finite performance over the continuous recorded body base.
 * Eligibility and playback options belong to Body; this owns only the wait and
 * its scheduler handle, including the time while that handle is still loading.
 */
export class OccasionalIdleMotion {
  private readonly random: () => number;
  private readonly waitRangeMs: readonly [number, number];
  private readonly activeDurationRangeMs?: readonly [number, number];
  private remainingMs: number;
  private retryMs = 0;
  private activeRemainingMs: number | null = null;
  private handle: MotionHandle | null = null;
  private disposed = false;
  private eligible = false;

  constructor(private readonly options: OccasionalIdleMotionOptions) {
    this.random = options.random ?? Math.random;
    const range = options.waitRangeMs;
    this.waitRangeMs = validRange(range) ? range : [180_000, 300_000];
    this.activeDurationRangeMs = validRange(options.activeDurationRangeMs)
      ? options.activeDurationRangeMs
      : undefined;
    this.remainingMs = this.sampleRange(this.waitRangeMs);
  }

  update(deltaMs: number, eligible: boolean, hardCancel = false): void {
    if (this.disposed) return;
    this.eligible = eligible && !hardCancel;
    if (!eligible || hardCancel) {
      this.stop(hardCancel);
      return;
    }
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;

    // A suspended tab must not catch up several minutes of idle on resumption.
    const elapsed = Math.min(deltaMs, 1_000);
    if (this.handle) {
      if (this.activeRemainingMs !== null) {
        this.activeRemainingMs = Math.max(0, this.activeRemainingMs - elapsed);
        if (this.activeRemainingMs === 0) this.stop(false);
      }
      return;
    }
    this.remainingMs = Math.max(0, this.remainingMs - elapsed);
    this.retryMs = Math.max(0, this.retryMs - elapsed);
    if (this.remainingMs > 0 || this.retryMs > 0) return;

    const handle = this.options.play();
    if (!handle) {
      this.retryMs = 2_500;
      return;
    }
    this.handle = handle;
    this.activeRemainingMs = this.activeDurationRangeMs
      ? this.sampleRange(this.activeDurationRangeMs)
      : null;
    void handle.completion.then(() => {
      if (this.handle !== handle) return;
      this.handle = null;
      this.resetWait();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.eligible = false;
    this.stop(true);
  }

  getSnapshot(): OccasionalIdleMotionSnapshot {
    return {
      eligible: this.eligible,
      disposed: this.disposed,
      waitRemainingMs: this.remainingMs,
      retryRemainingMs: this.retryMs,
      activeAnimation: this.handle?.animation ?? null,
      activeRemainingMs: this.activeRemainingMs,
    };
  }

  get isActive(): boolean {
    return this.handle?.isActive() ?? false;
  }

  private stop(immediate: boolean): void {
    const handle = this.handle;
    if (!handle) return;
    // Detach before stopping: late completion cannot alter a replacement's wait.
    this.handle = null;
    this.resetWait();
    if (immediate) handle.cancel();
    else handle.release(800);
  }

  private resetWait(): void {
    this.remainingMs = this.sampleRange(this.waitRangeMs);
    this.retryMs = 0;
    this.activeRemainingMs = null;
  }

  private sampleRange(range: readonly [number, number]): number {
    const random = this.random();
    const unit = Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 0.5;
    return range[0] + unit * (range[1] - range[0]);
  }
}

function validRange(
  range: readonly [number, number] | undefined,
): range is readonly [number, number] {
  return (
    range !== undefined &&
    Number.isFinite(range[0]) &&
    Number.isFinite(range[1]) &&
    range[0] >= 0 &&
    range[1] >= range[0]
  );
}

import type { MotionHandle } from "./motion-scheduler";

export interface OccasionalIdleMotionOptions {
  /** Return null while the reviewed asset or its physical entry is unavailable. */
  readonly play: () => MotionHandle | null;
  readonly random?: () => number;
  /** Quiet, eligible time between performances. Injectable for deterministic checks. */
  readonly waitRangeMs?: readonly [number, number];
}

/**
 * A rare, finite performance over the continuous recorded body base.
 * Eligibility and playback options belong to Body; this owns only the wait and
 * its scheduler handle, including the time while that handle is still loading.
 */
export class OccasionalIdleMotion {
  private readonly random: () => number;
  private readonly waitRangeMs: readonly [number, number];
  private remainingMs: number;
  private retryMs = 0;
  private handle: MotionHandle | null = null;
  private disposed = false;

  constructor(private readonly options: OccasionalIdleMotionOptions) {
    this.random = options.random ?? Math.random;
    const range = options.waitRangeMs;
    this.waitRangeMs =
      range &&
      Number.isFinite(range[0]) &&
      Number.isFinite(range[1]) &&
      range[0] >= 0 &&
      range[1] >= range[0]
        ? range
        : [180_000, 300_000];
    this.remainingMs = this.nextWait();
  }

  update(deltaMs: number, eligible: boolean, hardCancel = false): void {
    if (this.disposed) return;
    if (!eligible || hardCancel) {
      this.stop(hardCancel);
      return;
    }
    if (this.handle || !Number.isFinite(deltaMs) || deltaMs <= 0) return;

    // A suspended tab must not catch up several minutes of idle on resumption.
    const elapsed = Math.min(deltaMs, 1_000);
    this.remainingMs = Math.max(0, this.remainingMs - elapsed);
    this.retryMs = Math.max(0, this.retryMs - elapsed);
    if (this.remainingMs > 0 || this.retryMs > 0) return;

    const handle = this.options.play();
    if (!handle) {
      this.retryMs = 2_500;
      return;
    }
    this.handle = handle;
    void handle.completion.then(() => {
      if (this.handle !== handle) return;
      this.handle = null;
      this.resetWait();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop(true);
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
    this.remainingMs = this.nextWait();
    this.retryMs = 0;
  }

  private nextWait(): number {
    const random = this.random();
    const unit = Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 0.5;
    return this.waitRangeMs[0] + unit * (this.waitRangeMs[1] - this.waitRangeMs[0]);
  }
}

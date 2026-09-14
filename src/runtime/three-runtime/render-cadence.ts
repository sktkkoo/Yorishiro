const QUIET_FRAME_INTERVAL_MS = 1000 / 30;
const RECORDED_FRAME_INTERVAL_MS = 1000 / 60;
// RAF timestamps can land just before the nominal display deadline.
const DEADLINE_TOLERANCE_MS = 1;

/** Visible rendering cadence, independent of the simulation's actual elapsed time. */
export class RenderCadence {
  private nextDueAtMs: number | null = null;
  private intervalMs = QUIET_FRAME_INTERVAL_MS;

  reset(): void {
    this.nextDueAtMs = null;
  }

  takeFrame(nowMs: number, recordedPerformance: boolean, force = false): boolean {
    if (!Number.isFinite(nowMs)) return false;
    const intervalMs = recordedPerformance ? RECORDED_FRAME_INTERVAL_MS : QUIET_FRAME_INTERVAL_MS;
    if (this.nextDueAtMs === null || intervalMs !== this.intervalMs) {
      this.intervalMs = intervalMs;
      this.nextDueAtMs = nowMs;
    }
    const due = nowMs + DEADLINE_TOLERANCE_MS >= this.nextDueAtMs;
    if (!due) return force;
    // Carry fractional time instead of restarting the deadline at each RAF.
    // Missed frames advance the deadline; they never produce a render backlog.
    const intervals =
      Math.floor((nowMs + DEADLINE_TOLERANCE_MS - this.nextDueAtMs) / this.intervalMs) + 1;
    this.nextDueAtMs += intervals * this.intervalMs;
    return true;
  }
}

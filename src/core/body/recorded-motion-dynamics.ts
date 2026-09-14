export interface RecordedMotionDynamicsOutput {
  readonly torso: number;
  readonly head: number;
}

export interface RecordedMotionDynamicsOptions {
  readonly random?: () => number;
}

const RAMP_MS = 2_000;

/**
 * Alternates quiet and occasional stronger amplitudes of an existing recording.
 * It generates no poses or rotations. Body admits only quiet idle base playback;
 * speech, manual performances and deliberate survey gestures remain separate.
 */
export class RecordedMotionDynamics {
  private readonly random: () => number;
  private readonly output = { torso: 0.18, head: 0.06 };
  private waitSample: number;
  private waitProgress = 0;
  private accentElapsedMs = -1;
  private accentDurationMs = 0;
  private amount = 0;
  private releaseElapsedMs = -1;
  private releaseAmount = 0;

  constructor(options: RecordedMotionDynamicsOptions = {}) {
    this.random = options.random ?? Math.random;
    this.waitSample = this.draw();
  }

  /** Returns the same output object each frame. Zero delta also supplies the cold-start gains. */
  update(deltaMs: number, intensity: number, eligible: boolean): RecordedMotionDynamicsOutput {
    const strength = Number.isFinite(intensity) ? Math.max(0, Math.min(3, intensity)) : 1;
    if (strength === 0) {
      // Body also pauses the recorded source. Preserve the episode clock until
      // motion is enabled again; do not replay time spent in the zero setting.
      this.output.torso = 0;
      this.output.head = 0;
      return this.output;
    }
    const delta = Number.isFinite(deltaMs) ? Math.max(0, Math.min(1_000, deltaMs)) : 0;
    const level = Math.max(0, (strength - 1) / 2);

    if (!eligible && this.accentElapsedMs >= 0 && this.releaseElapsedMs < 0) {
      this.releaseAmount = this.amount;
      this.releaseElapsedMs = 0;
    }
    if (this.releaseElapsedMs >= 0) {
      // Retain the departing strength at the eligibility boundary, then settle
      // over two seconds. Re-entry cannot restart or prolong this release.
      this.releaseElapsedMs += delta;
      this.amount = this.releaseAmount * (1 - smooth(this.releaseElapsedMs / RAMP_MS));
      if (this.releaseElapsedMs >= RAMP_MS) this.finishAccent();
    } else if (eligible && this.accentElapsedMs >= 0) {
      this.accentElapsedMs += delta;
      this.amount =
        smooth(this.accentElapsedMs / RAMP_MS) *
        smooth((this.accentDurationMs - this.accentElapsedMs) / RAMP_MS);
      if (this.accentElapsedMs >= this.accentDurationMs) this.finishAccent();
    } else if (eligible && delta > 0) {
      const waitMin = 45_000 - level * 25_000;
      const waitMax = 90_000 - level * 50_000;
      // Keep progress, rather than elapsed time at the old level, so changing
      // intensity changes future cadence without suddenly making an accent due.
      this.waitProgress += delta / (waitMin + this.waitSample * (waitMax - waitMin));
      if (this.waitProgress >= 1 - 1e-12) {
        this.accentElapsedMs = 0;
        this.accentDurationMs = 8_000 + this.draw() * 2_000;
        this.waitProgress = 0;
      }
    }

    const reduced = Math.min(1, strength);
    const quietTorso = 0.18 + level * 0.47;
    const quietHead = 0.06 + level * 0.39;
    const accentTorso = 0.4 + level * 0.6;
    const accentHead = 0.35 + level * 0.65;
    this.output.torso = (quietTorso + this.amount * (accentTorso - quietTorso)) * reduced;
    this.output.head = (quietHead + this.amount * (accentHead - quietHead)) * reduced;
    return this.output;
  }

  private finishAccent(): void {
    this.accentElapsedMs = -1;
    this.releaseElapsedMs = -1;
    this.amount = 0;
    this.waitProgress = 0;
    this.waitSample = this.draw();
  }

  private draw(): number {
    const value = this.random();
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
  }
}

function smooth(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * BlinkSystem — autonomous blink generation.
 *
 * Extracted from vrm-procedural.ts. Pure data logic, no VRM dependency.
 * Body feeds the output value into ExpressionManager as a system-level
 * "blink" expression slot.
 *
 * Timing: 4-7s intervals, close ~50ms (rate 20/s), open ~83ms (rate 12/s).
 * Matches human blink physiology measurements.
 */

export class BlinkSystem {
  private timer: number;
  private active = false;
  private phase: 0 | 1 | 2 = 0; // 0=idle, 1=closing, 2=opening
  private blinkValue = 0;

  /** When true, auto-blink is suppressed (e.g., handler-driven blink). */
  private suppressed = false;

  private readonly random: () => number;

  constructor(random?: () => number) {
    this.random = random ?? Math.random;
    this.timer = 4.0 + this.random() * 2.0;
  }

  /** Advance the blink state machine. Returns the current blink value [0, 1]. */
  update(delta: number): number {
    if (this.suppressed) return 0;

    this.timer -= delta;
    if (this.timer <= 0 && !this.active) {
      this.active = true;
      this.phase = 1;
      this.timer = 4.0 + this.random() * 3.0;
    }

    if (this.active) {
      if (this.phase === 1) {
        // Closing: fast (20 units/sec)
        this.blinkValue = Math.min(this.blinkValue + delta * 20, 1.0);
        if (this.blinkValue >= 1.0) this.phase = 2;
      } else {
        // Opening: slower (12 units/sec)
        this.blinkValue = Math.max(this.blinkValue - delta * 12, 0.0);
        if (this.blinkValue <= 0.0) {
          this.active = false;
          this.phase = 0;
        }
      }
    }

    return this.blinkValue;
  }

  /** Current blink value [0, 1]. */
  get value(): number {
    return this.suppressed ? 0 : this.blinkValue;
  }

  /** Suppress auto-blink (when handler is driving blink expression). */
  suppress(): void {
    this.suppressed = true;
    this.blinkValue = 0;
    this.active = false;
    this.phase = 0;
  }

  /** Resume auto-blink after suppression. */
  resume(): void {
    this.suppressed = false;
    this.timer = 2.0 + this.random() * 2.0; // shorter wait after resume
  }
}

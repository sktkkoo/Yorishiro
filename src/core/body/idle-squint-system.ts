/**
 * IdleSquintSystem — occasional subtle eye narrowing during idle.
 *
 * Outputs a partial blink-expression weight with a short fade envelope.
 * Kept separate from BlinkSystem so it does not fight autonomous blinks.
 */

const NEXT_MIN_S = 8;
const NEXT_MAX_S = 22;
const DURATION_MIN_S = 0.4;
const DURATION_MAX_S = 1.0;
const FADE_S = 0.15;
const WEIGHT_MIN = 0.1;
const WEIGHT_MAX = 0.3;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class IdleSquintSystem {
  private nextTimer: number;
  private activeTimer = 0;
  private activeDuration = 0;
  private activeWeight = 0;
  private squintValue = 0;
  private enabled = true;

  private readonly random: () => number;

  constructor(random?: () => number) {
    this.random = random ?? Math.random;
    this.nextTimer = this.pickNextDelay();
  }

  update(delta: number, enabled: boolean): number {
    if (!enabled) {
      if (this.enabled) {
        this.nextTimer = this.pickNextDelay();
      }
      this.enabled = false;
      this.clearActive();
      return 0;
    }
    if (delta <= 0) return this.squintValue;
    this.enabled = true;

    if (this.activeDuration <= 0) {
      this.nextTimer -= delta;
      if (this.nextTimer <= 0) {
        this.startEpisode();
      }
    } else {
      this.activeTimer -= delta;
      if (this.activeTimer <= 0) {
        this.clearActive();
        this.nextTimer = this.pickNextDelay();
      }
    }

    this.squintValue = this.getStrength() * this.activeWeight;
    return this.squintValue;
  }

  get value(): number {
    return this.squintValue;
  }

  get isActive(): boolean {
    return this.activeDuration > 0;
  }

  private startEpisode(): void {
    this.activeDuration = DURATION_MIN_S + this.random() * (DURATION_MAX_S - DURATION_MIN_S);
    this.activeTimer = this.activeDuration;
    this.activeWeight = WEIGHT_MIN + this.random() * (WEIGHT_MAX - WEIGHT_MIN);
  }

  private clearActive(): void {
    this.activeTimer = 0;
    this.activeDuration = 0;
    this.activeWeight = 0;
    this.squintValue = 0;
  }

  private pickNextDelay(): number {
    return NEXT_MIN_S + this.random() * (NEXT_MAX_S - NEXT_MIN_S);
  }

  private getStrength(): number {
    if (this.activeDuration <= 0) return 0;
    const elapsed = this.activeDuration - this.activeTimer;
    const fadeWindow = Math.min(FADE_S, this.activeDuration / 2);
    const fadeIn = clamp(elapsed / fadeWindow, 0, 1);
    const fadeOut = clamp(this.activeTimer / fadeWindow, 0, 1);
    return Math.min(fadeIn, fadeOut);
  }
}

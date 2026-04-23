/**
 * CursorAttentionSystem — brief, delayed attention flicks toward the cursor.
 *
 * This intentionally avoids continuous cursor coupling. It schedules rare,
 * short episodes and outputs small head/eye offsets with a soft lag.
 */

export type CursorAttentionMode = "eyes" | "both";

export interface CursorAttentionOutput {
  readonly mode: CursorAttentionMode | null;
  readonly headYawRad: number;
  readonly headPitchRad: number;
  readonly eyeYawDeg: number;
  readonly eyePitchDeg: number;
}

export type CursorAttentionEvent =
  | {
      readonly kind: "start";
      readonly mode: CursorAttentionMode;
      readonly durationS: number;
      readonly nextDelayS: null;
    }
  | {
      readonly kind: "end";
      readonly mode: CursorAttentionMode;
      readonly durationS: number;
      readonly nextDelayS: number;
    };

const NEXT_MIN_S = 8;
const NEXT_MAX_S = 15;
const DURATION_MIN_S = 1.0;
const DURATION_MAX_S = 3.0;
const LAG_SPEED = 5.0;
const FADE_S = 0.25;

const HEAD_MAX_YAW_RAD = 0.22;
const HEAD_MAX_PITCH_RAD = 0.14;
const EYE_MAX_YAW_DEG = 45;
const EYE_MAX_PITCH_DEG = 30;
const POINTER_RANGE_RATIO_X = 0.35;
const POINTER_RANGE_RATIO_Y = 0.45;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lerpDelta(current: number, target: number, speed: number, delta: number): number {
  return current + (target - current) * Math.min(speed * delta, 1.0);
}

export class CursorAttentionSystem {
  private nextTimer: number;
  private activeTimer = 0;
  private activeDuration = 0;
  private mode: CursorAttentionMode | null = null;

  private targetX = 0;
  private targetY = 0;
  private lagX = 0;
  private lagY = 0;

  private readonly random: () => number;
  private readonly onEvent?: (event: CursorAttentionEvent) => void;

  constructor(random?: () => number, onEvent?: (event: CursorAttentionEvent) => void) {
    this.random = random ?? Math.random;
    this.onEvent = onEvent;
    this.nextTimer = this.pickNextDelay();
  }

  setPointerPosition(clientX: number, clientY: number, width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    this.targetX = clamp((clientX / width) * 2 - 1, -1, 1);
    this.targetY = clamp(1 - (clientY / height) * 2, -1, 1);
  }

  setPointerPositionFromHead(
    clientX: number,
    clientY: number,
    headClientX: number,
    headClientY: number,
    width: number,
    height: number,
  ): void {
    if (width <= 0 || height <= 0) return;
    const rangeX = Math.max(width * POINTER_RANGE_RATIO_X, 1);
    const rangeY = Math.max(height * POINTER_RANGE_RATIO_Y, 1);
    this.targetX = clamp((clientX - headClientX) / rangeX, -1, 1);
    this.targetY = clamp((headClientY - clientY) / rangeY, -1, 1);
  }

  update(delta: number): void {
    if (delta <= 0) return;

    this.lagX = lerpDelta(this.lagX, this.targetX, LAG_SPEED, delta);
    this.lagY = lerpDelta(this.lagY, this.targetY, LAG_SPEED, delta);

    if (this.mode === null) {
      this.nextTimer -= delta;
      if (this.nextTimer <= 0) {
        this.startEpisode();
      }
      return;
    }

    this.activeTimer -= delta;
    if (this.activeTimer <= 0) {
      const finishedMode = this.mode;
      const finishedDuration = this.activeDuration;
      this.mode = null;
      this.activeDuration = 0;
      this.activeTimer = 0;
      this.nextTimer = this.pickNextDelay();
      if (finishedMode !== null) {
        this.onEvent?.({
          kind: "end",
          mode: finishedMode,
          durationS: finishedDuration,
          nextDelayS: this.nextTimer,
        });
      }
    }
  }

  getOutput(): CursorAttentionOutput {
    const strength = this.getStrength();
    const headEnabled = this.mode === "both";
    const eyeEnabled = this.mode === "eyes" || this.mode === "both";

    return {
      mode: this.mode,
      headYawRad: headEnabled ? this.lagX * HEAD_MAX_YAW_RAD * strength : 0,
      headPitchRad: headEnabled ? this.lagY * HEAD_MAX_PITCH_RAD * strength : 0,
      eyeYawDeg: eyeEnabled ? this.targetX * EYE_MAX_YAW_DEG * strength : 0,
      eyePitchDeg: eyeEnabled ? -this.targetY * EYE_MAX_PITCH_DEG * strength : 0,
    };
  }

  get isActive(): boolean {
    return this.mode !== null;
  }

  getDebugSnapshot(): {
    readonly mode: CursorAttentionMode | null;
    readonly targetX: number;
    readonly targetY: number;
    readonly lagX: number;
    readonly lagY: number;
    readonly strength: number;
    readonly remainingS: number;
  } {
    return {
      mode: this.mode,
      targetX: this.targetX,
      targetY: this.targetY,
      lagX: this.lagX,
      lagY: this.lagY,
      strength: this.getStrength(),
      remainingS: this.activeTimer,
    };
  }

  private startEpisode(): void {
    this.activeDuration = DURATION_MIN_S + this.random() * (DURATION_MAX_S - DURATION_MIN_S);
    this.activeTimer = this.activeDuration;

    this.mode = this.random() < 0.5 ? "eyes" : "both";

    this.onEvent?.({
      kind: "start",
      mode: this.mode,
      durationS: this.activeDuration,
      nextDelayS: null,
    });
  }

  private pickNextDelay(): number {
    return NEXT_MIN_S + this.random() * (NEXT_MAX_S - NEXT_MIN_S);
  }

  private getStrength(): number {
    if (this.mode === null || this.activeDuration <= 0) return 0;
    const elapsed = this.activeDuration - this.activeTimer;
    const fadeWindow = Math.min(FADE_S, this.activeDuration / 2);
    const fadeIn = clamp(elapsed / fadeWindow, 0, 1);
    const fadeOut = clamp(this.activeTimer / fadeWindow, 0, 1);
    return Math.min(fadeIn, fadeOut);
  }
}

/**
 * EyeSystem — idle gaze + gaze override for CharacterAPI.gaze().
 *
 * Extracted from vrm-procedural.ts IdleEyeSystem, enhanced with:
 * - Override mode: gaze() call pauses idle and forces specific direction
 * - Override release: smoothly returns to idle
 *
 * Pure data logic — no VRM dependency. Body.update() applies the output
 * to vrm.lookAt.yaw / vrm.lookAt.pitch.
 */

export interface EyeOutput {
  yaw: number; // degrees
  pitch: number; // degrees
}

interface EyeDir {
  up: number;
  down: number;
  left: number;
  right: number;
}

const MAX_YAW = 30; // degrees
const MAX_PITCH = 25;

// ─── Idle gaze patterns ──────────────────────────────────

const IDLE_PATTERNS: ReadonlyArray<EyeDir> = [
  { up: 0, down: 0, left: 1.0, right: 0 },
  { up: 0, down: 0, left: 0, right: 1.0 },
  { up: 1.0, down: 0, left: 1.0, right: 0 },
  { up: 1.0, down: 0, left: 0, right: 1.0 },
  { up: 0, down: 0, left: 0, right: 0 }, // front
];

// ─── Override ────────────────────────────────────────────

interface GazeOverride {
  readonly id: number;
  readonly yaw: number;
  readonly pitch: number;
}

// ─── EyeSystem ───────────────────────────────────────────

export class EyeSystem {
  // ── Idle state ──
  private fixationTimer = 2.0 + Math.random() * 3.0;
  private saccadeProgress = 0;
  private saccadeDuration = 0.06;
  private isSaccading = false;

  private readonly target: EyeDir = { up: 0, down: 0, left: 0, right: 0 };
  private readonly current: EyeDir = { up: 0, down: 0, left: 0, right: 0 };
  private readonly saccadeStart: EyeDir = { up: 0, down: 0, left: 0, right: 0 };

  // Micro-saccade
  private microTimer = 0.3 + Math.random() * 0.4;
  private microYaw = 0;
  private microPitch = 0;
  private microYawTarget = 0;
  private microPitchTarget = 0;

  // ── Override state ──
  private override: GazeOverride | null = null;
  private nextOverrideId = 0;

  /** Dependency injection for testability. */
  private readonly random: () => number;

  constructor(random?: () => number) {
    this.random = random ?? Math.random;
  }

  update(delta: number): void {
    if (this.override) return; // idle paused during override
    this.updateIdle(delta);
  }

  getOutput(): EyeOutput {
    if (this.override) {
      return { yaw: this.override.yaw, pitch: this.override.pitch };
    }
    return this.getIdleOutput();
  }

  /**
   * Set a gaze override. Returns an ID to release it later.
   * Replaces any previous override.
   */
  setOverride(yaw: number, pitch: number): number {
    const id = ++this.nextOverrideId;
    this.override = { id, yaw, pitch };
    return id;
  }

  /**
   * Release an override by ID. Stale IDs (from replaced overrides)
   * are silently ignored.
   */
  releaseOverride(id: number): void {
    if (this.override?.id === id) {
      this.override = null;
    }
  }

  /** Whether a gaze override is currently active. */
  get hasOverride(): boolean {
    return this.override !== null;
  }

  // ── Idle internals ────────────────────────────────────

  private updateIdle(delta: number): void {
    if (!this.isSaccading) {
      // Micro-saccade during fixation
      this.microTimer -= delta;
      if (this.microTimer <= 0) {
        const amp = 0.018;
        this.microYawTarget = (this.random() - 0.5) * amp;
        this.microPitchTarget = (this.random() - 0.5) * amp;
        this.microTimer = 0.15 + this.random() * 0.35;
      }
      const mLerp = Math.min(10.0 * delta, 1.0);
      this.microYaw += (this.microYawTarget - this.microYaw) * mLerp;
      this.microPitch += (this.microPitchTarget - this.microPitch) * mLerp;

      // Fixation timer → start saccade
      this.fixationTimer -= delta;
      if (this.fixationTimer <= 0) {
        const patterns = IDLE_PATTERNS;
        const picked = patterns[Math.floor(this.random() * patterns.length)];

        const dist = Math.hypot(
          picked.up - this.current.up,
          picked.down - this.current.down,
          picked.left - this.current.left,
          picked.right - this.current.right,
        );
        this.saccadeDuration = Math.max(0.04, 0.04 + dist * 0.06);
        this.saccadeProgress = 0;

        this.saccadeStart.up = this.current.up;
        this.saccadeStart.down = this.current.down;
        this.saccadeStart.left = this.current.left;
        this.saccadeStart.right = this.current.right;

        this.target.up = picked.up;
        this.target.down = picked.down;
        this.target.left = picked.left;
        this.target.right = picked.right;

        this.isSaccading = true;
        this.fixationTimer = 2.0 + this.random() * 3.0;
      }
    } else {
      // Saccade phase: cubic ease-out
      this.saccadeProgress = Math.min(this.saccadeProgress + delta / this.saccadeDuration, 1.0);
      const eased = 1 - (1 - this.saccadeProgress) ** 3;

      this.current.up = this.saccadeStart.up + (this.target.up - this.saccadeStart.up) * eased;
      this.current.down =
        this.saccadeStart.down + (this.target.down - this.saccadeStart.down) * eased;
      this.current.left =
        this.saccadeStart.left + (this.target.left - this.saccadeStart.left) * eased;
      this.current.right =
        this.saccadeStart.right + (this.target.right - this.saccadeStart.right) * eased;

      if (this.saccadeProgress >= 1.0) {
        this.isSaccading = false;
        this.microYaw = 0;
        this.microPitch = 0;
        this.microYawTarget = 0;
        this.microPitchTarget = 0;
        this.microTimer = 0.1 + this.random() * 0.2;
      }
    }
  }

  private getIdleOutput(): EyeOutput {
    const microScale = this.isSaccading ? 0 : 1;
    return {
      yaw:
        (this.current.left - this.current.right) * MAX_YAW + this.microYaw * MAX_YAW * microScale,
      pitch:
        (this.current.up - this.current.down) * MAX_PITCH +
        this.microPitch * MAX_PITCH * microScale,
    };
  }
}

/**
 * Convert a GazeTarget from the SDK to yaw/pitch degrees for the EyeSystem.
 * Some targets (screen-element, text-region) are approximated.
 */
export type GazeTargetLike =
  | { kind: "point"; direction: { x: number; y: number; z: number } }
  | { kind: "screen-element"; selector: string }
  | { kind: "camera" }
  | { kind: "text-region"; bounds: { x: number; y: number; width: number; height: number } }
  | { kind: "away" };

export function gazeTargetToAngles(target: GazeTargetLike, random?: () => number): EyeOutput {
  const rng = random ?? Math.random;
  switch (target.kind) {
    case "camera":
      return { yaw: 0, pitch: 0 };
    case "away": {
      // Random direction, biased to the sides
      const sign = rng() > 0.5 ? 1 : -1;
      return {
        yaw: sign * (15 + rng() * 15),
        pitch: (rng() - 0.5) * 10,
      };
    }
    case "point": {
      // Convert direction vector to yaw/pitch
      const { x, z } = target.direction;
      const yaw = Math.atan2(x, z) * (180 / Math.PI);
      const pitch = Math.atan2(target.direction.y, Math.hypot(x, z)) * (180 / Math.PI);
      return {
        yaw: Math.max(-MAX_YAW, Math.min(MAX_YAW, yaw)),
        pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch)),
      };
    }
    case "screen-element":
      // Approximate: look slightly down (terminal is below eye level)
      return { yaw: 0, pitch: -10 };
    case "text-region":
      // Approximate: look toward the text region center
      return {
        yaw: (target.bounds.x + target.bounds.width / 2 - 0.5) * MAX_YAW * 2,
        pitch: -(target.bounds.y + target.bounds.height / 2 - 0.5) * MAX_PITCH * 2,
      };
  }
}

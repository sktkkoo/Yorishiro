/**
 * EyeSystem — state-dependent saccade/fixation + gaze override.
 *
 * Ported from old Yorishiro's EyeSystem with NLP eye-access cue patterns:
 * - idle: random周囲注視 (2-5s interval)
 * - thinking: upper gaze bias (0.8-1.8s interval, upper fixation 3-6s)
 * - reading: downward gaze
 * - writing: upper-right (visual construction)
 * - running: forward focus
 *
 * Override mode: gaze() call pauses idle and forces specific direction.
 * Pure data logic — no VRM dependency.
 */

export interface EyeOutput {
  yaw: number; // degrees
  pitch: number; // degrees
}

export type MutableEyeOutput = {
  yaw: number;
  pitch: number;
};

/**
 * Saccade 開始の通知（pull 型）。Body が毎フレーム consume して
 * eye-head coordination（大きい視線移動に頭が遅れて追従）と
 * gaze-evoked blink（大きい saccade が瞬きを誘発する生理現象）に使う。
 */
export interface SaccadeEvent {
  /** 移動量（pattern 空間の距離、おおよそ 0〜1.4）。 */
  readonly magnitude: number;
  /** Saccade 後の目標視線（degrees、正 = モデルの左）。 */
  readonly targetYawDeg: number;
  readonly targetPitchDeg: number;
  /** この saccade が瞬きを誘発するか（magnitude 閾値 + 確率抽選済み）。 */
  readonly blinkWorthy: boolean;
  /** 発生源。'glance' は beat 由来で、頭追従の閾値を idle と分けるために使う。 */
  readonly origin?: "idle" | "glance";
}

// Gaze-evoked blink: 視線の大移動時、人間は高確率で瞬きを伴う。
const GAZE_BLINK_MIN_MAGNITUDE = 0.6;
const GAZE_BLINK_PROB = 0.3;
// これ未満の移動は saccade とみなさない（front → front の縮退など）
const SACCADE_MIN_MAGNITUDE = 0.05;

interface EyeDir {
  up: number;
  down: number;
  left: number;
  right: number;
}

const FRONT_EYE_DIR: EyeDir = { up: 0, down: 0, left: 0, right: 0 };

const MAX_YAW = 30; // degrees
const MAX_PITCH = 25;
const OUTPUT_MAX_YAW = 56;
const OUTPUT_MAX_PITCH = 26;
const EYE_MAX_YAW_DEG = 56;
const EYE_MAX_PITCH_DEG = 26;
const AMBIENT_SACCADE_SPEED = 1 / 0.06;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ─── State-dependent gaze patterns (NLP eye-access cues) ─

/** Activity state for eye pattern selection. */
export type EyeState = "idle" | "thinking" | "reading" | "writing" | "running";

const THINKING_EYE: ReadonlyArray<EyeDir> = [
  { up: 0.5, down: 0, left: 0.8, right: 0 }, // visual memory (upper-left)
  { up: 0.5, down: 0, left: 0, right: 0.8 }, // visual construction (upper-right)
  { up: 0, down: 0, left: 1.0, right: 0 }, // auditory memory (lateral-left)
  { up: 0, down: 0, left: 0, right: 1.0 }, // auditory construction (lateral-right)
  { up: 0.2, down: 0, left: 0.3, right: 0 }, // soft front-up
  { up: 0, down: 0.4, left: 0, right: 0.5 }, // internal dialogue (lower-right)
  { up: 0, down: 0.3, left: 0.5, right: 0 }, // lower-left (kinesthetic)
  { up: 0, down: 0, left: 0, right: 0 }, // front (neutral reset)
];

const PATTERNS: Record<EyeState, ReadonlyArray<EyeDir>> = {
  idle: [
    { up: 0, down: 0, left: 1.0, right: 0 },
    { up: 0, down: 0, left: 0, right: 1.0 },
    { up: 0.3, down: 0, left: 0.8, right: 0 },
    { up: 0.3, down: 0, left: 0, right: 0.8 },
    { up: 0, down: 0.3, left: 0.6, right: 0 },
    { up: 0, down: 0.3, left: 0, right: 0.6 },
    { up: 0, down: 0, left: 0, right: 0 }, // front
    { up: 0, down: 0, left: 0, right: 0 }, // front ×2
  ],
  thinking: THINKING_EYE,
  reading: [
    { up: 0, down: 0.6, left: 1.0, right: 0 }, // lower-left
    { up: 0, down: 0.6, left: 0, right: 1.0 }, // lower-right
    { up: 0, down: 0.6, left: 1.0, right: 0 }, // weight: lower-left ×2
  ],
  writing: [
    { up: 0.7, down: 0, left: 0, right: 1.0 }, // visual construction (upper-right)
    { up: 0, down: 0, left: 0, right: 1.0 }, // auditory construction (lateral-right)
    { up: 0, down: 0, left: 0, right: 1.0 }, // lateral-right ×2
    { up: 0, down: 0.3, left: 0, right: 0.7 }, // lower-right (output focus)
  ],
  running: [
    { up: 0, down: 0, left: 0, right: 0 }, // front
    { up: 0, down: 0.5, left: 0, right: 0.8 }, // lower-right
    { up: 0, down: 0, left: 0, right: 0 }, // weight: front ×2
  ],
};

/** Fixation interval [min, max] seconds per state. */
const INTERVALS: Record<EyeState, [number, number]> = {
  idle: [2.0, 5.0],
  thinking: [0.8, 1.8],
  reading: [0.8, 1.8],
  writing: [0.8, 1.8],
  running: [0.8, 1.8],
};

// ─── Override ────────────────────────────────────────────

interface GazeOverride {
  readonly id: number;
  readonly yaw: number;
  readonly pitch: number;
}

// ─── EyeSystem ───────────────────────────────────────────

export class EyeSystem {
  // ── Idle state ──
  private fixationTimer: number;
  private saccadeProgress = 0;
  private saccadeDuration = 0.06;
  private isSaccading = false;

  private readonly target: EyeDir = { up: 0, down: 0, left: 0, right: 0 };
  private readonly current: EyeDir = { up: 0, down: 0, left: 0, right: 0 };
  private readonly saccadeStart: EyeDir = { up: 0, down: 0, left: 0, right: 0 };

  // Micro-saccade
  private microTimer: number;
  private microYaw = 0;
  private microPitch = 0;
  private microYawTarget = 0;
  private microPitchTarget = 0;

  // ── Override state ──
  private override: GazeOverride | null = null;
  private nextOverrideId = 0;
  private glanceHoldRemaining = 0;
  private glanceOverrideId = 0;

  // ── Ambient attention offset ──
  private ambientYaw = 0;
  private ambientPitch = 0;
  private ambientYawTarget = 0;
  private ambientPitchTarget = 0;

  // ── Activity state ──
  private _state: EyeState = "idle";

  // ── Saccade event（pull 型、consume で消える）──
  private pendingSaccade: SaccadeEvent | null = null;
  private readonly output: MutableEyeOutput = { yaw: 0, pitch: 0 };

  // 次の saccade を正面に強制する flag（注意の切り替え用）
  private forceFrontNext = false;

  /** Dependency injection for testability. */
  private readonly random: () => number;

  constructor(random?: () => number) {
    this.random = random ?? Math.random;
    // injectable random で初期 timer も決定的にする（field initializer だと
    // Math.random 直叩きになりテストから制御できない）
    this.fixationTimer = 2.0 + this.random() * 3.0;
    this.microTimer = 0.3 + this.random() * 0.4;
  }

  /** Set the activity state. Changes gaze patterns and saccade intervals. */
  setState(state: EyeState): void {
    if (state === this._state) return;
    const prev = this._state;
    this._state = state;

    if (state === "idle" && prev !== "idle") {
      // thinking/reading/running → idle: 視線を即座に正面に戻す。
      // 旧実装では current が thinking の上方パターンを保持したまま次の
      // saccade まで上を向き続けていた。
      this.current.up = 0;
      this.current.down = 0;
      this.current.left = 0;
      this.current.right = 0;
      this.target.up = 0;
      this.target.down = 0;
      this.target.left = 0;
      this.target.right = 0;
      this.isSaccading = false;
    }

    // Force a saccade on next fixation check to adopt new pattern quickly
    this.fixationTimer = Math.min(this.fixationTimer, 0.3);
  }

  get state(): EyeState {
    return this._state;
  }

  update(delta: number): void {
    this.updateAmbient(delta);
    if (this.override) {
      this.advanceMicrosaccade(delta); // hold 中も固視微動を維持(死に目防止)
      if (this.glanceHoldRemaining > 0) {
        this.glanceHoldRemaining -= delta;
        if (this.glanceHoldRemaining <= 0) {
          this.releaseOverride(this.glanceOverrideId);
          this.glanceOverrideId = 0;
        }
      }
      return;
    }
    this.updateIdle(delta);
  }

  getOutput(): EyeOutput {
    return { ...this.writeOutput(this.output) };
  }

  writeOutput(out: MutableEyeOutput): EyeOutput {
    if (this.override) {
      out.yaw = clamp(
        this.override.yaw + this.microYaw * MAX_YAW + this.ambientYaw,
        -OUTPUT_MAX_YAW,
        OUTPUT_MAX_YAW,
      );
      out.pitch = clamp(
        this.override.pitch + this.microPitch * MAX_PITCH + this.ambientPitch,
        -OUTPUT_MAX_PITCH,
        OUTPUT_MAX_PITCH,
      );
      return out;
    }
    const idle = this.getIdleOutput();
    out.yaw = clamp(idle.yaw + this.ambientYaw, -OUTPUT_MAX_YAW, OUTPUT_MAX_YAW);
    out.pitch = clamp(idle.pitch + this.ambientPitch, -OUTPUT_MAX_PITCH, OUTPUT_MAX_PITCH);
    return out;
  }

  setOverride(yaw: number, pitch: number): number {
    const id = ++this.nextOverrideId;
    this.override = { id, yaw, pitch };
    return id;
  }

  /**
   * beat 由来の視線移動。override を張ると同時に pendingSaccade を発行し、
   * Body の eye-head coordination(consumeSaccadeEvent → nudgeHeadToward)を
   * 通して頭を遅れて追従させる(eye-lead)。durationS 後に自動 release。
   */
  triggerGlance(yawDeg: number, pitchDeg: number, durationS: number): number {
    const id = ++this.nextOverrideId;
    this.override = { id, yaw: yawDeg, pitch: pitchDeg };
    this.glanceHoldRemaining = durationS;
    this.glanceOverrideId = id;
    const magnitude = Math.hypot(yawDeg / MAX_YAW, pitchDeg / MAX_PITCH);
    if (magnitude > SACCADE_MIN_MAGNITUDE) {
      this.pendingSaccade = {
        magnitude,
        targetYawDeg: yawDeg,
        targetPitchDeg: pitchDeg,
        blinkWorthy: magnitude >= GAZE_BLINK_MIN_MAGNITUDE && this.random() < GAZE_BLINK_PROB,
        origin: "glance",
      };
    }
    return id;
  }

  releaseOverride(id: number): void {
    if (this.override?.id === id) {
      this.override = null;
      if (this.glanceOverrideId === id) {
        this.glanceHoldRemaining = 0;
        this.glanceOverrideId = 0;
      }
    }
  }

  get hasOverride(): boolean {
    return this.override !== null;
  }

  setAmbientOffset(yaw: number, pitch: number): void {
    this.ambientYawTarget = clamp(yaw, -EYE_MAX_YAW_DEG, EYE_MAX_YAW_DEG);
    this.ambientPitchTarget = clamp(pitch, -EYE_MAX_PITCH_DEG, EYE_MAX_PITCH_DEG);
  }

  /** 直近の saccade 開始 event を 1 回だけ返す（pull したら消える）。 */
  consumeSaccadeEvent(): SaccadeEvent | null {
    const event = this.pendingSaccade;
    this.pendingSaccade = null;
    return event;
  }

  /**
   * 注意の切り替え（user の入力など）：視線をすぐ正面（作業対象）へ向け直す。
   * override 中は何もしない（明示的 gaze が優先）。
   */
  refocusFront(): void {
    if (this.override) return;
    this.forceFrontNext = true;
    this.fixationTimer = Math.min(this.fixationTimer, 0.05);
  }

  // ── Idle internals ────────────────────────────────────

  private updateAmbient(delta: number): void {
    const t = Math.min(AMBIENT_SACCADE_SPEED * delta, 1.0);
    this.ambientYaw += (this.ambientYawTarget - this.ambientYaw) * t;
    this.ambientPitch += (this.ambientPitchTarget - this.ambientPitch) * t;
  }

  private advanceMicrosaccade(delta: number): void {
    this.microTimer -= delta;
    if (this.microTimer <= 0) {
      const amp = 0.012; // 固視微動(やや控えめ、~0.36deg)
      this.microYawTarget = (this.random() - 0.5) * amp;
      this.microPitchTarget = (this.random() - 0.5) * amp;
      this.microTimer = 0.15 + this.random() * 0.35;
    }
    const mLerp = Math.min(10.0 * delta, 1.0);
    this.microYaw += (this.microYawTarget - this.microYaw) * mLerp;
    this.microPitch += (this.microPitchTarget - this.microPitch) * mLerp;
  }

  private updateIdle(delta: number): void {
    if (!this.isSaccading) {
      this.advanceMicrosaccade(delta);

      // Fixation timer → start saccade
      this.fixationTimer -= delta;
      if (this.fixationTimer <= 0) {
        const patterns = PATTERNS[this._state];
        const picked = this.forceFrontNext
          ? FRONT_EYE_DIR
          : patterns[Math.floor(this.random() * patterns.length)];
        this.forceFrontNext = false;

        const dist = Math.hypot(
          picked.up - this.current.up,
          picked.down - this.current.down,
          picked.left - this.current.left,
          picked.right - this.current.right,
        );
        const dYawDeg =
          (picked.left - picked.right - (this.current.left - this.current.right)) * MAX_YAW;
        const dPitchDeg =
          (picked.up - picked.down - (this.current.up - this.current.down)) * MAX_PITCH;
        const ampDeg = Math.hypot(dYawDeg, dPitchDeg);
        // main sequence D = D0 + d*A(D0/d は範囲で持つ出発点。research §2)
        this.saccadeDuration = clamp(0.021 + 0.0025 * ampDeg, 0.024, 0.12);
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

        // Saccade event の発行（縮退 saccade は通知しない）。blink 抽選は
        // ここで確定させる（injectable random で決定的にテストできる）。
        if (dist > SACCADE_MIN_MAGNITUDE) {
          this.pendingSaccade = {
            magnitude: dist,
            targetYawDeg: (picked.left - picked.right) * MAX_YAW,
            targetPitchDeg: (picked.up - picked.down) * MAX_PITCH,
            blinkWorthy: dist >= GAZE_BLINK_MIN_MAGNITUDE && this.random() < GAZE_BLINK_PROB,
            origin: "idle",
          };
        }

        // Thinking: upper gaze gets slightly longer fixation
        if (this._state === "thinking" && picked.up > 0.3) {
          this.fixationTimer = 1.2 + this.random() * 1.0;
        } else {
          const [min, max] = INTERVALS[this._state];
          this.fixationTimer = min + this.random() * (max - min);
        }
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
      const sign = rng() > 0.5 ? 1 : -1;
      return {
        yaw: sign * (15 + rng() * 15),
        pitch: (rng() - 0.5) * 10,
      };
    }
    case "point": {
      const { x, z } = target.direction;
      const yaw = Math.atan2(x, z) * (180 / Math.PI);
      const pitch = Math.atan2(target.direction.y, Math.hypot(x, z)) * (180 / Math.PI);
      return {
        yaw: Math.max(-MAX_YAW, Math.min(MAX_YAW, yaw)),
        pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch)),
      };
    }
    case "screen-element":
      return { yaw: 0, pitch: -10 };
    case "text-region":
      return {
        yaw: (target.bounds.x + target.bounds.width / 2 - 0.5) * MAX_YAW * 2,
        pitch: -(target.bounds.y + target.bounds.height / 2 - 0.5) * MAX_PITCH * 2,
      };
  }
}

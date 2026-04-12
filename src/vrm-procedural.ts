/**
 * Procedural VRM subsystems — 呼吸・まばたき・視線の自律的な生体運動。
 *
 * これらは handler や reaction とは独立に毎フレーム動く。
 * Philosophy: 「空白の充填」（Presence 三条件の第一条件）。
 * thinking 中にスピナーではなく微細な動きがあるだけで、そこに誰かが居ることになる。
 *
 * 旧 repo の BlinkSystem / EyeSystem / BodySystem からパラメータを port。
 * Phase 3.5 quick win として VrmViewer に直接組み込む。
 * Full Body primitive（Phase 3.6+）で CharacterAPI 経由に refactor 予定。
 */

import type { VRM } from "@pixiv/three-vrm";

// ─── Breathing ────────────────────────────────────────────

/**
 * 呼吸。vrm.scene.position.y を sin wave で微小に上下させる。
 * 振幅 5mm、周波数 0.8 Hz — 目を凝らさないと気づかない程度。
 */
export function applyBreathing(vrm: VRM, elapsed: number): void {
  vrm.scene.position.y = Math.sin(elapsed * 0.8) * 0.005;
}

// ─── Blink ────────────────────────────────────────────────

/**
 * まばたき。4-7 秒間隔でランダムに発生。
 * 閉じ: ~50ms (20/s)、開き: ~83ms (12/s) — 人間の実測値に近い。
 */
export class BlinkSystem {
  private timer = 4.0 + Math.random() * 2.0;
  private active = false;
  private phase: 0 | 1 | 2 = 0; // 0=idle, 1=closing, 2=opening
  private value = 0;

  update(delta: number): number {
    this.timer -= delta;
    if (this.timer <= 0 && !this.active) {
      this.active = true;
      this.phase = 1;
      this.timer = 4.0 + Math.random() * 3.0;
    }

    if (this.active) {
      if (this.phase === 1) {
        this.value = Math.min(this.value + delta * 20, 1.0);
        if (this.value >= 1.0) this.phase = 2;
      } else {
        this.value = Math.max(this.value - delta * 12, 0.0);
        if (this.value <= 0.0) {
          this.active = false;
          this.phase = 0;
        }
      }
    }

    return this.value;
  }

  apply(vrm: VRM): void {
    vrm.expressionManager?.setValue("blink", this.value);
  }
}

// ─── Idle Eye Movement ────────────────────────────────────

interface EyeDir {
  up: number;
  down: number;
  left: number;
  right: number;
}

/**
 * idle 時の視線運動。saccade/fixation cycle + micro-saccade。
 *
 * NLP 視線アクセスキューに基づく方向パターン:
 * - idle: ランダムに周囲を見る（2-5 秒間隔）
 * - saccade は cubic ease-out で高速開始→減速着地（主系列に近似）
 * - fixation 中は micro-saccade（振幅 ~0.018、間隔 150-500ms）で生体らしさ
 *
 * State-dependent pattern（thinking 時の上方固視など）は Phase 3.6+ で追加予定。
 */
export class IdleEyeSystem {
  private fixationTimer = 2.0 + Math.random() * 3.0;
  private saccadeProgress = 0;
  private saccadeDuration = 0.06;

  private readonly target: EyeDir = { up: 0, down: 0, left: 0, right: 0 };
  private readonly current: EyeDir = { up: 0, down: 0, left: 0, right: 0 };
  private readonly saccadeStart: EyeDir = { up: 0, down: 0, left: 0, right: 0 };

  private isSaccading = false;

  // Micro-saccade — 固視中の微小眼振（網膜疲労防止・生体らしさ）
  private microTimer = 0.3 + Math.random() * 0.4;
  private microYaw = 0;
  private microPitch = 0;
  private microYawTarget = 0;
  private microPitchTarget = 0;

  // idle pattern: ランダムに周囲を見る
  private static readonly IDLE_PATTERNS: ReadonlyArray<EyeDir> = [
    { up: 0, down: 0, left: 1.0, right: 0 },
    { up: 0, down: 0, left: 0, right: 1.0 },
    { up: 1.0, down: 0, left: 1.0, right: 0 },
    { up: 1.0, down: 0, left: 0, right: 1.0 },
    { up: 0, down: 0, left: 0, right: 0 }, // 正面
  ];

  update(delta: number): void {
    if (!this.isSaccading) {
      // ── Fixation phase ──

      // Micro-saccade
      this.microTimer -= delta;
      if (this.microTimer <= 0) {
        const amp = 0.018;
        this.microYawTarget = (Math.random() - 0.5) * amp;
        this.microPitchTarget = (Math.random() - 0.5) * amp;
        this.microTimer = 0.15 + Math.random() * 0.35;
      }
      const mLerp = Math.min(10.0 * delta, 1.0);
      this.microYaw += (this.microYawTarget - this.microYaw) * mLerp;
      this.microPitch += (this.microPitchTarget - this.microPitch) * mLerp;

      // Fixation timer → start saccade
      this.fixationTimer -= delta;
      if (this.fixationTimer <= 0) {
        const patterns = IdleEyeSystem.IDLE_PATTERNS;
        const picked = patterns[Math.floor(Math.random() * patterns.length)];

        // Saccade duration based on amplitude (主系列: 40-120ms)
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

        // Next fixation: 2-5 seconds for idle
        this.fixationTimer = 2.0 + Math.random() * 3.0;
      }
    } else {
      // ── Saccade phase ──
      // Cubic ease-out: fast start → decelerate to landing
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
        this.microTimer = 0.1 + Math.random() * 0.2;
      }
    }
  }

  apply(vrm: VRM): void {
    if (!vrm.lookAt) return;

    const MAX_YAW = 30; // degrees
    const MAX_PITCH = 25;
    const microScale = this.isSaccading ? 0 : 1;

    vrm.lookAt.yaw =
      (this.current.left - this.current.right) * MAX_YAW + this.microYaw * MAX_YAW * microScale;
    vrm.lookAt.pitch =
      (this.current.up - this.current.down) * MAX_PITCH + this.microPitch * MAX_PITCH * microScale;
  }
}

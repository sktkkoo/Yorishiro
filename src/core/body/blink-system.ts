/**
 * BlinkSystem — autonomous blink generation.
 *
 * Extracted from vrm-procedural.ts. Pure data logic, no VRM dependency.
 * Body feeds the output value into ExpressionManager as a system-level
 * "blink" expression slot.
 *
 * Timing: idle mean ~3.5s intervals, close ~50ms (rate 20/s), open ~83ms (rate 12/s).
 * Matches human blink physiology measurements.
 *
 * 生きている瞬きのための拡張：
 * - state 連動間隔：読み書き中は瞬きが減り、思考中はわずかに増える
 * - double blink：完了後たまに 2 連目が入る（人間の瞬きの自然な癖）
 * - requestBlink：外部刺激（大きい saccade / startle / 注意切替）で即時瞬き
 * - 速度 jitter：毎回の開閉速度がわずかに揺らぐ
 */

import type { EyeState } from "./eye-system";

// 安静 17/min(≈3.5s), 会話 26/min, 読書 4.5/min(Bentivoglio 1997)。
// Internal design-record: 2026-06-17-motion-aliveness-research.md §5
const INTERVAL_SCALE: Record<EyeState, number> = {
  idle: 1.0,
  thinking: 0.66, // 認知の切り替わりでやや増(≈26/min)
  reading: 3.8, // 読書で激減(≈4.5/min)
  writing: 3.5,
  running: 1.0,
};

const DOUBLE_BLINK_PROB = 0.15;
// 注意の切り替わり（state 遷移）に伴う認知瞬きの確率。人間は課題の区切りや
// 注意のシフトで瞬きを打つ（attentional blink punctuation）。
const COGNITIVE_BLINK_PROB = 0.4;
const CLOSE_RATE = 20; // units/sec（~50ms で閉じる）
const OPEN_RATE = 12; // units/sec（~83ms で開く）
const SPEED_JITTER = 0.3; // 毎回の開閉速度の揺らぎ幅（0.85〜1.15 倍）

export class BlinkSystem {
  private timer: number;
  private active = false;
  private phase: 0 | 1 | 2 = 0; // 0=idle, 1=closing, 2=opening
  private blinkValue = 0;
  private intervalScale = INTERVAL_SCALE.idle;
  private speedMul = 1.0;
  private currentState: EyeState = "idle";

  /** Active suppression tokens (e.g., handler-driven blink, idle squint). */
  private readonly suppressions = new Set<number>();
  private nextSuppressionToken = 0;

  private readonly random: () => number;

  constructor(random?: () => number) {
    this.random = random ?? Math.random;
    this.timer = 2.5 + this.random() * 2.0;
  }

  /**
   * Activity state に応じて瞬き間隔を変調する。state が実際に切り替わった
   * ときは確率的に認知瞬きを打つ（注意のシフトの句読点）。
   */
  setState(state: EyeState): void {
    const changed = state !== this.currentState;
    this.currentState = state;
    this.intervalScale = INTERVAL_SCALE[state];
    if (changed && this.random() < COGNITIVE_BLINK_PROB) {
      this.requestBlink();
    }
  }

  /**
   * 外部刺激による即時瞬き（gaze-evoked / startle / 注意切替）。
   * suppress 中・瞬き中は no-op。
   */
  requestBlink(): void {
    if (this.isSuppressed || this.active) return;
    this.timer = 0;
  }

  /** Advance the blink state machine. Returns the current blink value [0, 1]. */
  update(delta: number): number {
    if (this.isSuppressed) return 0;

    this.timer -= delta;
    if (this.timer <= 0 && !this.active) {
      this.active = true;
      this.phase = 1;
      this.timer = (2.5 + this.random() * 2.0) * this.intervalScale;
      this.speedMul = 1 - SPEED_JITTER / 2 + this.random() * SPEED_JITTER;
    }

    if (this.active) {
      if (this.phase === 1) {
        // Closing: fast
        this.blinkValue = Math.min(this.blinkValue + delta * CLOSE_RATE * this.speedMul, 1.0);
        if (this.blinkValue >= 1.0) this.phase = 2;
      } else {
        // Opening: slower
        this.blinkValue = Math.max(this.blinkValue - delta * OPEN_RATE * this.speedMul, 0.0);
        if (this.blinkValue <= 0.0) {
          this.active = false;
          this.phase = 0;
          // たまに 2 連瞬き。次の自然瞬き間隔を短い間合いで上書きする。
          if (this.random() > 1 - DOUBLE_BLINK_PROB) {
            this.timer = 0.15 + this.random() * 0.2;
          }
        }
      }
    }

    return this.blinkValue;
  }

  /** Current blink value [0, 1]. */
  get value(): number {
    return this.isSuppressed ? 0 : this.blinkValue;
  }

  get isSuppressed(): boolean {
    return this.suppressions.size > 0;
  }

  /** Suppress auto-blink. The returned token must be released with resume(). */
  suppress(): number {
    const token = ++this.nextSuppressionToken;
    this.suppressions.add(token);
    this.blinkValue = 0;
    this.active = false;
    this.phase = 0;
    return token;
  }

  /** Resume auto-blink after suppression. */
  resume(token: number): void {
    if (!this.suppressions.delete(token) || this.isSuppressed) return;
    this.timer = (2.0 + this.random() * 2.0) * this.intervalScale; // shorter wait after resume
  }
}

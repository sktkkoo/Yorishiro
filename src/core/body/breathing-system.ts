/**
 * BreathingSystem — 呼吸の生理。
 *
 * 旧実装（Body.applyBreathing の単一 sine position bob）を置き換える。
 * 生きている呼吸に必要な性質を pure logic で持つ：
 *
 * - 累積位相方式：モード変更で周波数が変わっても波形が連続（elapsed * freq
 *   方式だと周波数変更の瞬間に位相が飛ぶ）
 * - state 連動：focused（作業中）は速く浅く、relaxed は深くゆっくり
 * - OrganicNoise による周期・振幅の揺らぎ（毎回同じ呼吸をしない）
 * - ため息 / 深い一呼吸（triggerDeepBreath）：idle / relaxed では自発的にも入る
 * - 息止め（hold）：startle 反射で一瞬呼吸が止まる
 *
 * 出力は Y 位置オフセットに加えて胸郭・肩の微小回転。Body が position.y に、
 * ProceduralBones が spine / upperArm に加算合成する。
 *
 * Pure data logic, no VRM dependency.
 */

import { motionGain } from "./motion-gain";
import { OrganicNoise } from "./organic-noise";

export type BreathingMode = "idle" | "focused" | "relaxed";

export interface BreathingOutput {
  /** VRM scene 全体の Y 位置オフセット。 */
  readonly offsetY: number;
  /** 胸（spine）の前後回転オフセット（radians）。吸気で胸が起きる。 */
  readonly chestPitch: number;
  /** 肩（upperArm rotation.z への加算、radians）。吸気でわずかに上がる。 */
  readonly shoulderLift: number;
}

type MutableBreathingOutput = {
  offsetY: number;
  chestPitch: number;
  shoulderLift: number;
};

// 各モードの角周波数（rad/s）と深さ係数。idle の 0.8 rad/s は旧実装の
// BREATHING_FREQUENCY をそのまま引き継ぐ（約 7.6 呼吸/分の安静呼吸）。
const MODE_PARAMS: Record<BreathingMode, { rate: number; depth: number }> = {
  idle: { rate: 0.8, depth: 1.0 },
  focused: { rate: 1.15, depth: 0.7 },
  relaxed: { rate: 0.6, depth: 1.3 },
};

const OFFSET_Y_AMP = 0.005; // 旧 BREATHING_AMPLITUDE と同値
const CHEST_AMP = 0.0175; // radians
const SHOULDER_AMP = 0.008; // radians

const RATE_LERP = 1.5; // モード遷移の追従速度（units/sec）
const DEPTH_LERP = 1.0;
const AMP_NOISE = 0.12; // 振幅の揺らぎ幅（±12%）
const RATE_NOISE = 0.08; // 周期の揺らぎ幅（±8%）

// ため息：1 回の深い吸気→長い呼気。envelope で通常波形と crossfade するため
// 開始位相に依存せず必ず深いピークが出る。
const DEEP_DURATION_S = 7;
const DEEP_SCALE = 2.3;
const SIGH_MIN_S = 25;
const SIGH_MAX_S = 50;

export class BreathingSystem {
  private mode: BreathingMode = "idle";
  private rate = MODE_PARAMS.idle.rate;
  private depth = MODE_PARAMS.idle.depth;
  private phase = 0;
  private tInternal = 0;

  /** 1.0 以上で deep breath 非アクティブ。0→1 で envelope が進行する。 */
  private deepProgress = 1;
  private sighTimer: number;
  private holdTimer = 0;
  private intensity = 1.0;
  private readonly lastOutput: MutableBreathingOutput = {
    offsetY: 0,
    chestPitch: 0,
    shoulderLift: 0,
  };

  private readonly ampNoise: OrganicNoise;
  private readonly rateNoise: OrganicNoise;
  private readonly random: () => number;

  constructor(random?: () => number) {
    this.random = random ?? Math.random;
    this.ampNoise = new OrganicNoise(0.13, this.random);
    this.rateNoise = new OrganicNoise(0.09, this.random);
    this.sighTimer = SIGH_MIN_S + this.random() * (SIGH_MAX_S - SIGH_MIN_S);
  }

  setMode(mode: BreathingMode): void {
    this.mode = mode;
  }

  /** idle motion 倍率（0-3, 1 で現状）。breathing 軸の gain として振幅に乗算。 */
  setIntensity(intensity: number): void {
    this.intensity = intensity;
  }

  /** ため息 / 深い一呼吸を 1 回入れる。進行中なら no-op。 */
  triggerDeepBreath(): void {
    if (this.deepProgress < 1) return;
    this.deepProgress = 0;
    this.sighTimer = SIGH_MIN_S + this.random() * (SIGH_MAX_S - SIGH_MIN_S);
  }

  /** 呼吸を durationS 秒止める（startle 反射用）。再呼び出しで上書き。 */
  hold(durationS: number): void {
    this.holdTimer = durationS;
  }

  update(delta: number): BreathingOutput {
    if (this.holdTimer > 0) {
      this.holdTimer -= delta;
      return this.lastOutput;
    }

    this.tInternal += delta;

    // モード遷移は lerp で滑らかに（瞬間切替しない）
    const target = MODE_PARAMS[this.mode];
    this.rate += (target.rate - this.rate) * Math.min(RATE_LERP * delta, 1);
    this.depth += (target.depth - this.depth) * Math.min(DEPTH_LERP * delta, 1);

    const rateMul = 1 + RATE_NOISE * this.rateNoise.sample(this.tInternal);
    const ampMul = 1 + AMP_NOISE * this.ampNoise.sample(this.tInternal);
    this.phase += this.rate * rateMul * delta;

    // 自発ため息は安静時のみ（作業中の focused では入れない）
    if (this.mode !== "focused") {
      this.sighTimer -= delta;
      if (this.sighTimer <= 0) this.triggerDeepBreath();
    }

    let breathValue = Math.sin(this.phase);
    if (this.deepProgress < 1) {
      this.deepProgress = Math.min(this.deepProgress + delta / DEEP_DURATION_S, 1);
      const p = this.deepProgress;
      // envelope は両端 0 の crossfade。深呼吸の波形は速い吸気→緩い呼気
      // （p^0.7 でピークを前倒し）。
      const env = Math.sin(Math.PI * p) ** 2;
      const deep = Math.sin(Math.PI * p ** 0.7) * DEEP_SCALE;
      breathValue = (1 - env) * breathValue + env * deep;
    }

    const gain = motionGain(this.intensity, "breathing");
    const value = breathValue * this.depth * ampMul * gain;
    this.lastOutput.offsetY = value * OFFSET_Y_AMP;
    this.lastOutput.chestPitch = value * CHEST_AMP;
    this.lastOutput.shoulderLift = value * SHOULDER_AMP;
    return this.lastOutput;
  }
}

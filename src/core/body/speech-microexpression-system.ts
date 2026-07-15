import type { MouthValues } from "../voice/mouth-values";

export interface SpeechMicroexpressionParams {
  engagementEnabled: boolean;
  blinkEnabled: boolean;
  flickEnabled: boolean;
  speechThreshold: number;
  attackMs: number;
  releaseMs: number;
  engagementBrowWeight: number;
  engagementEyeWeight: number;
  browWeightMax: number;
  eyeWeightMax: number;
  gapThresholdMs: number;
  blinkProbability: number;
  onsetThreshold: number;
  onsetMinVolume: number;
  refractoryMs: number;
  flickDurationMs: number;
  flickWeight: number;
}

// tentative: 実機調整前提
export const DEFAULT_SPEECH_MICROEXPRESSION_PARAMS: Readonly<SpeechMicroexpressionParams> = {
  engagementEnabled: true,
  blinkEnabled: true,
  flickEnabled: true,
  speechThreshold: 0.05,
  attackMs: 150,
  releaseMs: 800,
  engagementBrowWeight: 0.06,
  engagementEyeWeight: 0.04,
  browWeightMax: 0.14,
  eyeWeightMax: 0.08,
  gapThresholdMs: 250,
  blinkProbability: 0.6,
  onsetThreshold: 0.22,
  onsetMinVolume: 0.3,
  refractoryMs: 1_500,
  flickDurationMs: 250,
  flickWeight: 0.08,
};

export interface SpeechMicroexpressionOutput {
  browWeight: number;
  eyeWeight: number;
  blinkRequested: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function approach(current: number, target: number, step: number): number {
  if (current < target) return Math.min(target, current + step);
  return Math.max(target, current - step);
}

/**
 * 発話音響から、眉・目元の賦活とフレーズ境界 blink を作る純ロジック層。
 * 感情は推定せず、Body が一度だけ取得した lip-sync 値だけを入力に使う。
 */
export class SpeechMicroexpressionSystem {
  private readonly random: () => number;
  private readonly currentParams: SpeechMicroexpressionParams = {
    ...DEFAULT_SPEECH_MICROEXPRESSION_PARAMS,
  };
  private readonly out: SpeechMicroexpressionOutput = {
    browWeight: 0,
    eyeWeight: 0,
    blinkRequested: false,
  };

  private engagementValue = 0;
  private speechObserved = false;
  private gapElapsedS = 0;
  private gapHandled = false;
  private previousVolume = 0;
  private refractoryRemainingS = 0;
  private flickElapsedS = 0;
  private flickActive = false;

  constructor(random?: () => number) {
    this.random = random ?? Math.random;
  }

  /** 現在の調整値へ部分更新を適用する。 */
  setParams(params: Partial<SpeechMicroexpressionParams>): void {
    const next = this.currentParams;
    if (params.engagementEnabled !== undefined) {
      next.engagementEnabled = params.engagementEnabled;
    }
    if (params.blinkEnabled !== undefined) next.blinkEnabled = params.blinkEnabled;
    if (params.flickEnabled !== undefined) next.flickEnabled = params.flickEnabled;
    if (params.speechThreshold !== undefined) {
      next.speechThreshold = clamp(params.speechThreshold, 0, 1);
    }
    if (params.attackMs !== undefined) next.attackMs = Math.max(1, params.attackMs);
    if (params.releaseMs !== undefined) next.releaseMs = Math.max(1, params.releaseMs);
    if (params.engagementBrowWeight !== undefined) {
      next.engagementBrowWeight = Math.max(0, params.engagementBrowWeight);
    }
    if (params.engagementEyeWeight !== undefined) {
      next.engagementEyeWeight = Math.max(0, params.engagementEyeWeight);
    }
    if (params.browWeightMax !== undefined) {
      next.browWeightMax = clamp(params.browWeightMax, 0, 1);
    }
    if (params.eyeWeightMax !== undefined) {
      next.eyeWeightMax = clamp(params.eyeWeightMax, 0, 1);
    }
    if (params.gapThresholdMs !== undefined) {
      next.gapThresholdMs = Math.max(0, params.gapThresholdMs);
    }
    if (params.blinkProbability !== undefined) {
      next.blinkProbability = clamp(params.blinkProbability, 0, 1);
    }
    if (params.onsetThreshold !== undefined) {
      next.onsetThreshold = clamp(params.onsetThreshold, 0, 1);
    }
    if (params.onsetMinVolume !== undefined) {
      next.onsetMinVolume = clamp(params.onsetMinVolume, 0, 1);
    }
    if (params.refractoryMs !== undefined) {
      next.refractoryMs = Math.max(0, params.refractoryMs);
    }
    if (params.flickDurationMs !== undefined) {
      next.flickDurationMs = Math.max(1, params.flickDurationMs);
    }
    if (params.flickWeight !== undefined) {
      next.flickWeight = Math.max(0, params.flickWeight);
    }
  }

  /** 発話エンゲージメント envelope の現在値。 */
  get engagement(): number {
    return this.engagementValue;
  }

  /**
   * 1 frame 分の信号を進め、再利用される出力 object を返す。
   * mouth=null と enabled=false は停止を表し、状態を即座に初期化する。
   */
  update(
    delta: number,
    mouth: Readonly<MouthValues> | null,
    enabled: boolean,
  ): SpeechMicroexpressionOutput {
    this.clearOutput();
    if (!enabled || mouth === null) {
      this.reset();
      return this.out;
    }

    const safeDelta = Math.max(0, delta);
    const volume = Math.max(mouth.aa, mouth.ih, mouth.ou, mouth.ee, mouth.oh);
    const speaking = volume > this.currentParams.speechThreshold;

    this.updateEngagement(safeDelta, speaking);
    this.updateBlink(safeDelta, speaking);
    const flickStrength = this.updateFlick(safeDelta, volume, speaking);

    const engagementBrow = this.engagementValue * this.currentParams.engagementBrowWeight;
    const engagementEye = this.engagementValue * this.currentParams.engagementEyeWeight;
    this.out.browWeight = clamp(
      engagementBrow + flickStrength * this.currentParams.flickWeight,
      0,
      this.currentParams.browWeightMax,
    );
    this.out.eyeWeight = clamp(engagementEye, 0, this.currentParams.eyeWeightMax);
    this.previousVolume = volume;
    return this.out;
  }

  private updateEngagement(delta: number, speaking: boolean): void {
    if (!this.currentParams.engagementEnabled) {
      this.engagementValue = 0;
      return;
    }
    const durationS =
      (speaking ? this.currentParams.attackMs : this.currentParams.releaseMs) / 1_000;
    this.engagementValue = approach(this.engagementValue, speaking ? 1 : 0, delta / durationS);
  }

  private updateBlink(delta: number, speaking: boolean): void {
    if (!this.currentParams.blinkEnabled) {
      this.resetBlink();
      return;
    }
    if (speaking) {
      this.speechObserved = true;
      this.gapElapsedS = 0;
      this.gapHandled = false;
      return;
    }
    if (!this.speechObserved || this.gapHandled) return;

    this.gapElapsedS += delta;
    if (this.gapElapsedS < this.currentParams.gapThresholdMs / 1_000) return;
    this.gapHandled = true;
    this.out.blinkRequested = this.random() < this.currentParams.blinkProbability;
  }

  private updateFlick(delta: number, volume: number, speaking: boolean): number {
    if (!this.currentParams.flickEnabled) {
      this.refractoryRemainingS = 0;
      this.flickElapsedS = 0;
      this.flickActive = false;
      return 0;
    }

    this.refractoryRemainingS = Math.max(0, this.refractoryRemainingS - delta);
    const isOnset =
      speaking &&
      volume >= this.currentParams.onsetMinVolume &&
      volume - this.previousVolume >= this.currentParams.onsetThreshold;
    if (isOnset && this.refractoryRemainingS <= 0) {
      this.flickActive = true;
      this.flickElapsedS = 0;
      this.refractoryRemainingS = this.currentParams.refractoryMs / 1_000;
    }

    if (!this.flickActive) return 0;
    const durationS = this.currentParams.flickDurationMs / 1_000;
    this.flickElapsedS += delta;
    if (this.flickElapsedS >= durationS) {
      this.flickActive = false;
      this.flickElapsedS = 0;
      return 0;
    }
    const progress = this.flickElapsedS / durationS;
    return progress <= 0.5 ? progress * 2 : (1 - progress) * 2;
  }

  private clearOutput(): void {
    this.out.browWeight = 0;
    this.out.eyeWeight = 0;
    this.out.blinkRequested = false;
  }

  private resetBlink(): void {
    this.speechObserved = false;
    this.gapElapsedS = 0;
    this.gapHandled = false;
  }

  private reset(): void {
    this.engagementValue = 0;
    this.resetBlink();
    this.previousVolume = 0;
    this.refractoryRemainingS = 0;
    this.flickElapsedS = 0;
    this.flickActive = false;
  }
}

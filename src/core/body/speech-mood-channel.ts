export interface SpeechMoodHandle {
  setIntensity(intensity: number): void;
  release(): void;
}

export type AcquireSpeechMood = (preset: string, intensity: number) => SpeechMoodHandle;

// tentative: 実機調整前提
const SPEECH_MOOD_ATTACK_S = 0.3;
const SPEECH_MOOD_RELEASE_S = 0.5;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** 発話単位の mood slot に attack / release envelope を与える。 */
export class SpeechMoodChannel {
  private readonly acquire: AcquireSpeechMood;
  private handle: SpeechMoodHandle | null = null;
  private intensity = 0;
  private envelope = 0;
  private releasing = false;

  constructor(acquire: AcquireSpeechMood) {
    this.acquire = acquire;
  }

  /** 前の mood を上書きし、0 weight から attack を開始する。 */
  setSpeechMood(preset: string, intensity: number): void {
    this.handle?.release();
    this.intensity = clamp(Number.isFinite(intensity) ? intensity : 1, 0, 1);
    this.envelope = 0;
    this.releasing = false;
    this.handle = this.acquire(preset, 0);
  }

  /** 現在値から release を開始する。 */
  releaseSpeechMood(): void {
    if (!this.handle) return;
    this.releasing = true;
    if (this.envelope <= 0) this.finishRelease();
  }

  /** Body の frame delta で envelope を進める。 */
  update(delta: number): void {
    const handle = this.handle;
    if (!handle || delta <= 0) return;

    if (this.releasing) {
      this.envelope = Math.max(0, this.envelope - delta / SPEECH_MOOD_RELEASE_S);
    } else {
      this.envelope = Math.min(1, this.envelope + delta / SPEECH_MOOD_ATTACK_S);
    }
    handle.setIntensity(this.envelope * this.intensity);
    if (this.releasing && this.envelope <= 0) this.finishRelease();
  }

  private finishRelease(): void {
    this.handle?.release();
    this.handle = null;
    this.intensity = 0;
    this.envelope = 0;
    this.releasing = false;
  }
}

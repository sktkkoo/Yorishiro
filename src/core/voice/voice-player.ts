import type {
  SayOptions,
  VoiceAPI,
  VoiceClipRef,
  VoiceHandle,
  VoicePlayOptions,
} from "@charminal/sdk";
import { invoke } from "@tauri-apps/api/core";
import { getAudioContext } from "./audio-context";
import { LipSyncAnalyser } from "./lip-sync-analyser";
import type { MouthValues } from "./mouth-values";
import { ZERO_MOUTH } from "./mouth-values";
import type { TtsEngine } from "./tts-engine";

const FADE_OUT_MS = 150;

/** post-MVP 用スタブハンドル（clip 再生は未実装） */
const stubHandle = (): VoiceHandle => ({
  startedAt: 0,
  stop: () => Promise.resolve(),
  completion: Promise.resolve(),
});

/**
 * TTS 音声を Web Audio パイプラインで再生する VoicePlayer。
 * LipSyncAnalyser を内蔵し、再生中は sample() で口形素が取れる。
 *
 * engine が渡されなかった場合は従来の tts_speak フォールバック（lip sync なし）。
 */
export class VoicePlayer {
  private readonly voice: string | null;
  private readonly engine: TtsEngine | null;

  // Web Audio graph (engine 使用時のみ構築)
  private analyserNode: AnalyserNode | null = null;
  private gainNode: GainNode | null = null;
  private lipSync: LipSyncAnalyser | null = null;
  private currentSource: AudioBufferSourceNode | null = null;
  private animFrameId: number | null = null;
  private onMouthValues: ((values: MouthValues) => void) | null = null;

  constructor(voice?: string, engine?: TtsEngine) {
    this.voice = voice ?? null;
    this.engine = engine ?? null;
  }

  /** 口形素コールバックを設定する。rAF ループで毎フレーム呼ばれる。 */
  setMouthCallback(cb: (values: MouthValues) => void): void {
    this.onMouthValues = cb;
  }

  /** 現在の口形素を 1 回取得する（コールバック不使用時のポーリング用）。 */
  sampleMouth(): MouthValues {
    return this.lipSync?.sample() ?? { ...ZERO_MOUTH };
  }

  createVoiceAPI(): VoiceAPI {
    return {
      say: (text: string, _options?: SayOptions): VoiceHandle => {
        if (this.engine) {
          return this.sayViaWebAudio(text);
        }
        return this.sayViaOsTts(text);
      },

      play: (_clipRef: VoiceClipRef, _options?: VoicePlayOptions): VoiceHandle => stubHandle(),

      silence: (_fadeMs?: number): void => {
        this.stopPlayback();
        invoke("tts_stop", {});
      },
    };
  }

  dispose(): void {
    this.stopPlayback();
    this.onMouthValues = null;
  }

  // ---------------------------------------------------------------------------
  // Web Audio パイプライン (engine あり)
  // ---------------------------------------------------------------------------

  private sayViaWebAudio(text: string): VoiceHandle {
    const startedAt = Date.now();
    let stopped = false;

    const completion = (async () => {
      const audioData = await this.engine?.synthesize(text, this.voice ?? undefined);
      if (!audioData) return;
      if (stopped) return;

      const ctx = getAudioContext();
      if (ctx.state === "suspended") await ctx.resume();

      this.ensureGraph(ctx);

      const audioBuffer = await ctx.decodeAudioData(audioData);
      if (stopped) return;

      await this.playBuffer(ctx, audioBuffer);
    })();

    return {
      startedAt,
      stop: () => {
        stopped = true;
        this.stopPlayback();
        return Promise.resolve();
      },
      completion,
    };
  }

  private ensureGraph(ctx: AudioContext): void {
    if (this.analyserNode) return;

    this.analyserNode = LipSyncAnalyser.createAnalyserNode(ctx);
    this.gainNode = ctx.createGain();
    this.analyserNode.connect(this.gainNode);
    this.gainNode.connect(ctx.destination);
    this.lipSync = new LipSyncAnalyser(this.analyserNode);
  }

  private playBuffer(ctx: AudioContext, buffer: AudioBuffer): Promise<void> {
    this.stopSource();

    return new Promise((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.analyserNode as AnalyserNode);
      this.currentSource = source;

      this.lipSync?.reset();
      this.startLipSyncLoop();

      source.onended = () => {
        if (this.currentSource === source) {
          this.currentSource = null;
          this.stopLipSyncLoop();
          this.onMouthValues?.({ ...ZERO_MOUTH });
        }
        resolve();
      };

      source.start();
    });
  }

  private stopPlayback(): void {
    this.fadeOutAndStop();
    this.stopLipSyncLoop();
    this.onMouthValues?.({ ...ZERO_MOUTH });
  }

  private stopSource(): void {
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch {
        /* already stopped */
      }
      this.currentSource = null;
    }
  }

  private fadeOutAndStop(): void {
    const source = this.currentSource;
    const gain = this.gainNode;
    if (!gain || !source) {
      this.stopSource();
      return;
    }
    this.currentSource = null;
    const ctx = getAudioContext();
    gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + FADE_OUT_MS / 1000);
    setTimeout(() => {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      gain.gain.setValueAtTime(1, ctx.currentTime);
    }, FADE_OUT_MS + 10);
  }

  // ---------------------------------------------------------------------------
  // LipSync rAF ループ
  // ---------------------------------------------------------------------------

  private startLipSyncLoop(): void {
    if (this.animFrameId !== null) return;
    const tick = () => {
      if (!this.lipSync) return;
      this.onMouthValues?.(this.lipSync.sample());
      this.animFrameId = requestAnimationFrame(tick);
    };
    this.animFrameId = requestAnimationFrame(tick);
  }

  private stopLipSyncLoop(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // 従来の OS TTS フォールバック (engine なし / debug 用)
  // ---------------------------------------------------------------------------

  private sayViaOsTts(text: string): VoiceHandle {
    const completion = invoke("tts_speak", {
      text,
      voice: this.voice,
    }).then(() => {});

    return {
      startedAt: Date.now(),
      stop: () => invoke("tts_stop", {}).then(() => {}),
      completion,
    };
  }
}

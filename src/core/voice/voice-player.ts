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
const ANALYSIS_GAIN = 1;
const BUFFER_ANALYSIS_WINDOW_MS = 32;
const BUFFER_ANALYSIS_VOLUME_SCALE = 0.12;

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
  private analysisGainNode: GainNode | null = null;
  private analysisSinkNode: GainNode | null = null;
  private gainNode: GainNode | null = null;
  private lipSync: LipSyncAnalyser | null = null;
  private currentSource: AudioBufferSourceNode | null = null;
  private animFrameId: number | null = null;
  private onMouthValues: ((values: MouthValues) => void) | null = null;
  private analysisBuffer: AudioBuffer | null = null;
  private analysisStartedAtMs = 0;

  constructor(voice?: string, engine?: TtsEngine) {
    this.voice = voice ?? null;
    this.engine = engine ?? null;
  }

  /** 口形素コールバックを設定する。rAF ループで毎フレーム呼ばれる。 */
  setMouthCallback(cb: (values: MouthValues) => void): void {
    this.onMouthValues = cb;
  }

  /** 現在の口形素を 1 回取得する。AnalyserNode を優先し、信号なければ buffer analysis にフォールバック。 */
  sampleMouth(): MouthValues {
    const analysed = this.lipSync?.sample() ?? ZERO_MOUTH;
    if (hasMouthSignal(analysed)) return analysed;

    const bufferAnalysed = this.sampleAnalysisBuffer();
    if (hasMouthSignal(bufferAnalysed)) return bufferAnalysed;

    return { ...ZERO_MOUTH };
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
      let audioBuffer: AudioBuffer | null = null;
      try {
        const audioData = await this.engine?.synthesize(text, this.voice ?? undefined);
        if (!audioData || stopped) return;

        const ctx = getAudioContext();
        if (ctx.state === "suspended") await ctx.resume();

        this.ensureGraph(ctx);

        audioBuffer = await decodeAudioData(ctx, audioData);
        if (stopped) return;

        await this.playBuffer(ctx, audioBuffer);
      } catch (error) {
        if (stopped) return;
        this.stopPlayback();
        console.error("[voice] Web Audio TTS failed; lip sync cannot run.", error);
        if (audioBuffer) this.startBufferAnalysis(audioBuffer);
        await invoke("tts_speak", { text, voice: this.voice });
      }
    })();

    return {
      startedAt,
      stop: () => {
        stopped = true;
        this.stopPlayback();
        this.stopBufferAnalysis();
        void invoke("tts_stop", {});
        return Promise.resolve();
      },
      completion,
    };
  }

  private ensureGraph(ctx: AudioContext): void {
    if (this.analyserNode) return;

    this.analyserNode = LipSyncAnalyser.createAnalyserNode(ctx);
    this.analysisGainNode = ctx.createGain();
    this.analysisGainNode.gain.value = ANALYSIS_GAIN;
    this.analysisSinkNode = ctx.createGain();
    this.analysisSinkNode.gain.value = 0;
    this.gainNode = ctx.createGain();

    this.analysisGainNode.connect(this.analyserNode);
    this.analyserNode.connect(this.analysisSinkNode);
    this.analysisSinkNode.connect(ctx.destination);
    this.gainNode.connect(ctx.destination);
    this.lipSync = new LipSyncAnalyser(this.analyserNode);
  }

  private playBuffer(ctx: AudioContext, buffer: AudioBuffer): Promise<void> {
    this.stopSource();

    return new Promise((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.analysisGainNode as GainNode);
      source.connect(this.gainNode as GainNode);
      this.currentSource = source;
      this.gainNode?.gain.setValueAtTime(1, ctx.currentTime);

      this.lipSync?.reset();
      this.startBufferAnalysis(buffer);
      this.startLipSyncLoop();

      source.onended = () => {
        if (this.currentSource === source) {
          this.currentSource = null;
          this.stopLipSyncLoop();
          this.stopBufferAnalysis();
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
    this.stopBufferAnalysis();
    this.onMouthValues?.({ ...ZERO_MOUTH });
  }

  private startBufferAnalysis(buffer: AudioBuffer): void {
    this.analysisBuffer = buffer;
    this.analysisStartedAtMs = performance.now();
  }

  private stopBufferAnalysis(): void {
    this.analysisBuffer = null;
    this.analysisStartedAtMs = 0;
  }

  private sampleAnalysisBuffer(): MouthValues {
    const buffer = this.analysisBuffer;
    if (!buffer) return { ...ZERO_MOUTH };

    const elapsedSeconds = (performance.now() - this.analysisStartedAtMs) / 1000;
    if (elapsedSeconds < 0 || elapsedSeconds > buffer.duration) {
      return { ...ZERO_MOUTH };
    }

    const centerFrame = Math.floor(elapsedSeconds * buffer.sampleRate);
    const halfWindow = Math.max(
      1,
      Math.floor((BUFFER_ANALYSIS_WINDOW_MS / 1000) * buffer.sampleRate * 0.5),
    );
    const startFrame = Math.max(0, centerFrame - halfWindow);
    const endFrame = Math.min(buffer.length, centerFrame + halfWindow);
    if (startFrame >= endFrame) return { ...ZERO_MOUTH };

    let squareSum = 0;
    let peak = 0;
    let count = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);
      for (let frame = startFrame; frame < endFrame; frame++) {
        const sample = data[frame];
        squareSum += sample * sample;
        peak = Math.max(peak, Math.abs(sample));
        count += 1;
      }
    }

    const rms = count > 0 ? Math.sqrt(squareSum / count) : 0;
    const volume = Math.min(Math.max(rms, peak * 0.5) / BUFFER_ANALYSIS_VOLUME_SCALE, 1);
    if (volume < 0.05) return { ...ZERO_MOUTH };

    return { aa: volume, ih: 0, ou: 0, ee: 0, oh: 0 };
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
      this.onMouthValues?.(this.sampleMouth());
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

async function decodeAudioData(ctx: AudioContext, audioData: ArrayBuffer): Promise<AudioBuffer> {
  try {
    return decodePcm16Wav(ctx, audioData);
  } catch {
    try {
      return await ctx.decodeAudioData(audioData.slice(0));
    } catch {
      throw new Error(`Unable to decode synthesized audio (${audioData.byteLength} bytes)`);
    }
  }
}

function decodePcm16Wav(ctx: AudioContext, wav: ArrayBuffer): AudioBuffer {
  const view = new DataView(wav);
  if (wav.byteLength < 44 || readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") {
    throw new Error("Unsupported WAV container");
  }

  let offset = 12;
  let audioFormat = 0;
  let numberOfChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= wav.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;
    const chunkEnd = chunkDataOffset + chunkSize;
    if (chunkEnd > wav.byteLength) {
      throw new Error("Truncated WAV chunk");
    }

    if (chunkId === "fmt ") {
      if (chunkSize < 16) throw new Error("Invalid WAV fmt chunk");
      audioFormat = view.getUint16(chunkDataOffset, true);
      numberOfChannels = view.getUint16(chunkDataOffset + 2, true);
      sampleRate = view.getUint32(chunkDataOffset + 4, true);
      bitsPerSample = view.getUint16(chunkDataOffset + 14, true);
    } else if (chunkId === "data") {
      dataOffset = chunkDataOffset;
      dataSize = chunkSize;
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (
    audioFormat !== 1 ||
    bitsPerSample !== 16 ||
    numberOfChannels < 1 ||
    sampleRate < 1 ||
    dataOffset < 0
  ) {
    throw new Error("Unsupported WAV format");
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataSize / (numberOfChannels * bytesPerSample));
  const buffer = ctx.createBuffer(numberOfChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numberOfChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let frame = 0; frame < frameCount; frame++) {
      const sampleOffset = dataOffset + (frame * numberOfChannels + channel) * bytesPerSample;
      const sample = view.getInt16(sampleOffset, true);
      channelData[frame] = sample < 0 ? sample / 32768 : sample / 32767;
    }
  }

  return buffer;
}

function readAscii(view: DataView, offset: number, length: number): string {
  let value = "";
  for (let i = 0; i < length; i++) {
    value += String.fromCharCode(view.getUint8(offset + i));
  }
  return value;
}

function hasMouthSignal(values: MouthValues): boolean {
  return values.aa > 0 || values.ih > 0 || values.ou > 0 || values.ee > 0 || values.oh > 0;
}

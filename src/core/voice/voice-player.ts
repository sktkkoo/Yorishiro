import type {
  SayOptions,
  VoiceAPI,
  VoiceClipRef,
  VoiceHandle,
  VoicePlayOptions,
} from "@charminal/sdk";
import { invoke } from "@tauri-apps/api/core";
import { ensureAudioContextRunning, getAudioContext } from "./audio-context";
import { LipSyncAnalyser } from "./lip-sync-analyser";
import type { MouthValues } from "./mouth-values";
import { ZERO_MOUTH } from "./mouth-values";
import type { TtsEngine } from "./tts-engine";
import { isPlayableVoiceUrl, resolveSharedVoiceRef } from "./voice-clip-resolver";

const FADE_OUT_MS = 150;
const BUFFER_ANALYSIS_WINDOW_MS = 32;
const BUFFER_ANALYSIS_VOLUME_SCALE = 0.12;
const BUFFER_SILENCE_THRESHOLD = 0.05;

export type VoiceClipResolver = (clipRef: VoiceClipRef) => Promise<string | null> | string | null;

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
  private silentSinkNode: GainNode | null = null;
  private gainNode: GainNode | null = null;
  private graphContext: AudioContext | null = null;
  private lipSync: LipSyncAnalyser | null = null;
  private currentSource: AudioBufferSourceNode | null = null;
  private currentPlaybackId: number | null = null;
  private nextPlaybackId = 1;
  private fadeResetGeneration = 0;
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

  createVoiceAPI(options: { readonly resolveClip?: VoiceClipResolver } = {}): VoiceAPI {
    return {
      say: (text: string, options?: SayOptions): VoiceHandle => {
        if (this.engine) {
          return this.sayViaWebAudio(text, options);
        }
        return this.sayViaOsTts(text);
      },

      play: (clipRef: VoiceClipRef, playOptions?: VoicePlayOptions): VoiceHandle =>
        this.playClip(clipRef, playOptions, options.resolveClip),

      silence: (_fadeMs?: number): void => {
        this.stopPlayback();
        invoke("tts_stop", {});
      },
    };
  }

  dispose(): void {
    this.stopPlayback();
    this.disconnectGraph();
    this.onMouthValues = null;
  }

  // ---------------------------------------------------------------------------
  // Web Audio パイプライン (engine あり)
  // ---------------------------------------------------------------------------

  private sayViaWebAudio(text: string, options?: SayOptions): VoiceHandle {
    const startedAt = Date.now();
    const playbackId = this.createPlaybackId();
    let stopped = false;

    const completion = (async () => {
      let audioBuffer: AudioBuffer | null = null;
      try {
        const audioData = await this.engine?.synthesize(text, this.voice ?? undefined);
        if (!audioData || stopped) return;

        const ctx = await ensureAudioContextRunning();

        this.ensureGraph(ctx);

        audioBuffer = await decodeAudioData(ctx, audioData);
        if (stopped) return;

        await this.playBuffer(playbackId, ctx, audioBuffer, normalizeVolume(options?.volume));
      } catch (error) {
        if (stopped) return;
        this.stopPlayback(playbackId);
        console.error("[voice] Web Audio TTS failed; lip sync cannot run.", error);
        if (audioBuffer) this.startBufferAnalysis(audioBuffer);
        await invoke("tts_speak", { text, voice: this.voice });
      }
    })();

    return {
      startedAt,
      stop: () => {
        stopped = true;
        this.stopPlayback(playbackId);
        this.stopBufferAnalysis();
        void invoke("tts_stop", {});
        return Promise.resolve();
      },
      completion,
    };
  }

  private ensureGraph(ctx: AudioContext): void {
    if (this.graphContext === ctx) return;

    this.stopSource();
    this.disconnectGraph();

    this.analyserNode = LipSyncAnalyser.createAnalyserNode(ctx);
    this.silentSinkNode = ctx.createGain();
    this.silentSinkNode.gain.value = 0;
    this.gainNode = ctx.createGain();

    this.analyserNode.connect(this.silentSinkNode);
    this.silentSinkNode.connect(ctx.destination);
    this.gainNode.connect(ctx.destination);
    this.lipSync = new LipSyncAnalyser(this.analyserNode);
    this.graphContext = ctx;
  }

  private playClip(
    clipRef: VoiceClipRef,
    options?: VoicePlayOptions,
    resolveClip?: VoiceClipResolver,
  ): VoiceHandle {
    let startedAt = 0;
    const playbackId = this.createPlaybackId();
    let stopped = false;

    const completion = (async () => {
      const url = await this.resolveClipUrl(clipRef, resolveClip);
      if (stopped) return;
      if (url === null) {
        throw new Error(`Unable to resolve voice clip '${clipRef}'`);
      }

      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const audioData = await response.arrayBuffer();
        if (stopped) return;

        const ctx = await ensureAudioContextRunning();

        this.ensureGraph(ctx);

        const audioBuffer = await decodeAudioData(ctx, audioData);
        if (stopped) return;

        await this.playBuffer(
          playbackId,
          ctx,
          audioBuffer,
          normalizeVolume(options?.volume),
          () => {
            startedAt = Date.now();
          },
        );
      } catch (error) {
        if (!stopped) {
          console.error(`[voice] Failed to play clip '${clipRef}'.`, error);
          throw error;
        }
      }
    })();
    void completion.catch(() => {});

    return {
      get startedAt() {
        return startedAt;
      },
      stop: () => {
        stopped = true;
        this.stopPlayback(playbackId);
        return Promise.resolve();
      },
      completion,
    };
  }

  private async resolveClipUrl(
    clipRef: VoiceClipRef,
    scopedResolver?: VoiceClipResolver,
  ): Promise<string | null> {
    const scoped = await resolveWith(scopedResolver, clipRef);
    if (scoped !== null) return scoped;

    const shared = resolveSharedVoiceRef(clipRef);
    if (shared !== null) return shared;

    // Direct URL playback is intentionally kept for host-owned or already-sanitized refs.
    // User pack-local paths should go through the scoped resolver above.
    if (isPlayableVoiceUrl(clipRef)) return clipRef;
    return null;
  }

  private playBuffer(
    playbackId: number,
    ctx: AudioContext,
    buffer: AudioBuffer,
    volume = 1,
    onStart?: () => void,
  ): Promise<void> {
    this.fadeResetGeneration += 1;
    this.stopSource();

    return new Promise((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.analyserNode as AnalyserNode);
      source.connect(this.gainNode as GainNode);
      this.currentSource = source;
      this.currentPlaybackId = playbackId;
      this.gainNode?.gain.cancelScheduledValues(ctx.currentTime);
      this.gainNode?.gain.setValueAtTime(volume, ctx.currentTime);

      this.lipSync?.reset();
      this.startBufferAnalysis(buffer);
      this.startLipSyncLoop();

      source.onended = () => {
        if (this.currentSource === source && this.currentPlaybackId === playbackId) {
          this.currentSource = null;
          this.currentPlaybackId = null;
          this.stopLipSyncLoop();
          this.stopBufferAnalysis();
          this.onMouthValues?.({ ...ZERO_MOUTH });
        }
        resolve();
      };

      source.start();
      onStart?.();
    });
  }

  private stopPlayback(playbackId?: number): void {
    if (playbackId !== undefined && this.currentPlaybackId !== playbackId) return;
    this.fadeOutAndStop(playbackId);
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
    if (volume < BUFFER_SILENCE_THRESHOLD) return { ...ZERO_MOUTH };

    return { aa: volume, ih: 0, ou: 0, ee: 0, oh: 0 };
  }

  private stopSource(playbackId?: number): void {
    if (playbackId !== undefined && this.currentPlaybackId !== playbackId) return;
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch {
        /* already stopped */
      }
      this.currentSource = null;
      this.currentPlaybackId = null;
    }
  }

  private fadeOutAndStop(playbackId?: number): void {
    if (playbackId !== undefined && this.currentPlaybackId !== playbackId) return;
    const source = this.currentSource;
    const gain = this.gainNode;
    if (!gain || !source) {
      this.stopSource(playbackId);
      return;
    }
    this.currentSource = null;
    this.currentPlaybackId = null;
    const ctx = this.graphContext ?? getAudioContext();
    const resetGeneration = this.fadeResetGeneration;
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + FADE_OUT_MS / 1000);
    setTimeout(() => {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      if (this.fadeResetGeneration === resetGeneration) {
        gain.gain.setValueAtTime(1, ctx.currentTime);
      }
    }, FADE_OUT_MS + 10);
  }

  private disconnectGraph(): void {
    this.fadeResetGeneration += 1;
    disconnectNode(this.analyserNode);
    disconnectNode(this.silentSinkNode);
    disconnectNode(this.gainNode);
    this.analyserNode = null;
    this.silentSinkNode = null;
    this.gainNode = null;
    this.lipSync = null;
    this.graphContext = null;
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

  private createPlaybackId(): number {
    const id = this.nextPlaybackId;
    this.nextPlaybackId += 1;
    return id;
  }
}

async function resolveWith(
  resolver: VoiceClipResolver | undefined | null,
  clipRef: VoiceClipRef,
): Promise<string | null> {
  if (!resolver) return null;
  try {
    return (await resolver(clipRef)) ?? null;
  } catch {
    return null;
  }
}

function normalizeVolume(volume: number | undefined): number {
  if (volume === undefined || !Number.isFinite(volume)) return 1;
  return Math.min(Math.max(volume, 0), 1);
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

function disconnectNode(node: AudioNode | null): void {
  try {
    node?.disconnect();
  } catch {
    /* already disconnected */
  }
}

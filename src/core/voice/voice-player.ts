import { invoke } from "@tauri-apps/api/core";
import type {
  SayOptions,
  VoiceAPI,
  VoiceClipRef,
  VoiceHandle,
  VoicePlayOptions,
} from "@yorishiro/sdk";
import { ensureAudioContextRunning, getAudioContext } from "./audio-context";
import { LipSyncAnalyser } from "./lip-sync-analyser";
import type { MouthValues } from "./mouth-values";
import { clearMouthValues, copyMouthValues, createMouthValues, ZERO_MOUTH } from "./mouth-values";
import type { TtsEngine } from "./tts-engine";
import { isPlayableVoiceUrl, resolveSharedVoiceRef } from "./voice-clip-resolver";

const FADE_OUT_MS = 150;

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
  private readonly mouthSampleScratch = createMouthValues();
  private readonly mouthCallbackScratch = createMouthValues();

  constructor(voice?: string, engine?: TtsEngine) {
    this.voice = voice ?? null;
    this.engine = engine ?? null;
  }

  /** 口形素コールバックを設定する。rAF ループで毎フレーム呼ばれる。 */
  setMouthCallback(cb: (values: MouthValues) => void): void {
    this.onMouthValues = cb;
    if (this.currentSource !== null) this.startLipSyncLoop();
  }

  /** 現在の口形素を 1 回取得する（コールバック不使用時のポーリング用）。 */
  sampleMouth(out?: MouthValues): MouthValues {
    if (this.currentSource !== null && this.lipSync) return this.lipSync.sample(out);
    return out ? clearMouthValues(out) : { ...ZERO_MOUTH };
  }

  /** Body 側が idle frame で analyser を pull しないための cheap active 判定。 */
  isMouthActive(): boolean {
    return this.currentSource !== null && this.lipSync !== null;
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
      try {
        const audioData = await this.engine?.synthesize(text, this.voice ?? undefined);
        if (!audioData || stopped) return;

        const ctx = await ensureAudioContextRunning();

        this.ensureGraph(ctx);

        const audioBuffer = await decodeAudioData(ctx, audioData);
        if (stopped) return;

        await this.playBuffer(playbackId, ctx, audioBuffer, normalizeVolume(options?.volume));
      } catch (error) {
        if (stopped) return;
        this.stopPlayback(playbackId);
        console.error("[voice] Web Audio TTS failed; lip sync cannot run.", error);
        await invoke("tts_speak", { text, voice: this.voice });
      }
    })();

    return {
      startedAt,
      stop: () => {
        stopped = true;
        this.stopPlayback(playbackId);
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
      if (this.onMouthValues !== null) this.startLipSyncLoop();

      source.onended = () => {
        if (this.currentSource === source && this.currentPlaybackId === playbackId) {
          this.currentSource = null;
          this.currentPlaybackId = null;
          this.stopLipSyncLoop();
          this.onMouthValues?.(clearMouthValues(this.mouthCallbackScratch));
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
    this.onMouthValues?.(clearMouthValues(this.mouthCallbackScratch));
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
    if (this.onMouthValues === null) return;
    const tick = () => {
      const onMouthValues = this.onMouthValues;
      if (onMouthValues === null || this.currentSource === null) {
        this.animFrameId = null;
        return;
      }
      onMouthValues(
        copyMouthValues(this.sampleMouth(this.mouthSampleScratch), this.mouthCallbackScratch),
      );
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
    // decodeAudioData は渡した ArrayBuffer を detach するため、失敗時に
    // decodePcm16Wav へ元 bytes を渡せるよう copy を渡す。
    return await ctx.decodeAudioData(audioData.slice(0));
  } catch {
    try {
      return decodePcm16Wav(ctx, audioData);
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

function disconnectNode(node: AudioNode | null): void {
  try {
    node?.disconnect();
  } catch {
    /* already disconnected */
  }
}

import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * TTS エンジンの抽象。音声データ (WAV ArrayBuffer) を返す。
 * 再生方法はエンジンの関心外 — VoicePlayer が Web Audio で再生する。
 */
export interface TtsEngine {
  readonly name: string;
  synthesize(text: string, voice?: string): Promise<ArrayBuffer>;
}

/** macOS say / Windows PowerShell を使う OS ネイティブ TTS。 */
export class SayTtsEngine implements TtsEngine {
  readonly name = "say";

  async synthesize(text: string, voice?: string): Promise<ArrayBuffer> {
    const channel = new Channel<ArrayBuffer>();
    const audioData = new Promise<ArrayBuffer>((resolve) => {
      channel.onmessage = resolve;
    });

    await invoke("tts_synthesize", {
      text,
      voice: voice ?? null,
      onOutput: channel,
    });
    return audioData;
  }
}

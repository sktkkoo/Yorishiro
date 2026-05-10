import { invoke } from "@tauri-apps/api/core";

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
    const base64: string = await invoke("tts_synthesize", {
      text,
      voice: voice ?? null,
    });
    return base64ToArrayBuffer(base64);
  }
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

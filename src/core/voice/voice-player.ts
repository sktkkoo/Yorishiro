import type {
  SayOptions,
  VoiceAPI,
  VoiceClipRef,
  VoiceHandle,
  VoicePlayOptions,
} from "@charminal/sdk";
import { invoke } from "@tauri-apps/api/core";

/** post-MVP 用スタブハンドル（clip 再生は未実装） */
const stubHandle = (): VoiceHandle => ({
  startedAt: 0,
  stop: () => Promise.resolve(),
  completion: Promise.resolve(),
});

/**
 * OS ネイティブ TTS を Tauri command 経由で呼ぶ VoicePlayer。
 * macOS: say, Windows: PowerShell System.Speech, 他: silent no-op。
 *
 * Body パターンに倣い、createVoiceAPI() で SDK インターフェースを返す。
 * SDK surface: src/sdk/context.d.ts VoiceAPI (484-491)
 */
export class VoicePlayer {
  private readonly voice: string | null;

  constructor(voice?: string) {
    this.voice = voice ?? null;
  }

  createVoiceAPI(): VoiceAPI {
    return {
      say: (text: string, _options?: SayOptions): VoiceHandle => {
        const completion = invoke("tts_speak", {
          text,
          voice: this.voice,
        }).then(() => {});

        return {
          startedAt: Date.now(),
          stop: () => invoke("tts_stop", {}).then(() => {}),
          completion,
        };
      },

      play: (_clipRef: VoiceClipRef, _options?: VoicePlayOptions): VoiceHandle => stubHandle(),

      silence: (_fadeMs?: number): void => {
        invoke("tts_stop", {});
      },
    };
  }
}

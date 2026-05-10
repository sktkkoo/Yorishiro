/**
 * Voice フラグメント。
 *
 * config.json の voiceFrequency に応じた TTS 利用指針を
 * グローバル system prompt に注入する。
 */

import type { ResolvedLanguage } from "../../runtime/language/language";
import { registerGlobalPromptFragment } from "./index";
import { getVoiceGuide, type VoiceLevel } from "./prompts";

async function provideVoice(language: ResolvedLanguage): Promise<string> {
  let level: VoiceLevel = "high";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const text = await invoke<string>("read_charminal_file", {
      relativePath: "config.json",
    });
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw.voiceFrequency === "none" || raw.voiceFrequency === "low") {
      level = raw.voiceFrequency;
    }
  } catch {
    // config 未存在 or parse 失敗 → default "high"
  }
  return getVoiceGuide(language, level);
}

/** App 初期化時に呼ぶ。 */
export function registerVoiceFragment(): void {
  registerGlobalPromptFragment("voice", provideVoice);
}

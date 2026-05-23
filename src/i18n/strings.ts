import type { FixedTerminalPromptKey } from "@charminal/sdk";
import type { ResolvedLanguage } from "../runtime/language/language";

export interface UiStrings {
  readonly settings: string;
  readonly closeSettings: string;
  readonly language: string;
  readonly languageAuto: string;
  readonly languageEnglish: string;
  readonly languageJapanese: string;
  readonly notLoaded: string;
  readonly loading: string;
  readonly noPacks: string;
  readonly unmuteAmbient: string;
  readonly muteAmbient: string;
  readonly ambientVolume: string;
  readonly selectVrmFile: string;
  readonly agentAppliesNextLaunch: string;
  readonly helpPrompt: string;
  readonly tutorialPrompt: string;
  readonly shortcutPrompt: string;
  readonly createPackPrompt: string;
  readonly pomodoroPrompt: string;
  readonly selectProjectFolder: string;
  readonly defaultFolderName: string;
  readonly voiceFrequency: string;
  readonly voiceOn: string;
  readonly voiceOff: string;
  readonly voiceAppliesNextSession: string;
}

const EN: UiStrings = {
  settings: "Settings",
  closeSettings: "Close settings",
  language: "Language",
  languageAuto: "Auto",
  languageEnglish: "English",
  languageJapanese: "Japanese",
  notLoaded: "(not loaded)",
  loading: "Loading...",
  noPacks: "(no packs)",
  unmuteAmbient: "Unmute ambient sound",
  muteAmbient: "Mute ambient sound",
  ambientVolume: "Ambient volume",
  selectVrmFile: "Select VRM file",
  agentAppliesNextLaunch: "Applies from the next agent launch",
  helpPrompt: "/charm:help",
  tutorialPrompt: "/charm:tutorial",
  shortcutPrompt: "/charm:shortcut I want to change keyboard shortcuts",
  createPackPrompt: "/charm:create I want to create a pack",
  pomodoroPrompt: "/charm:help I want to use Pomodoro",
  selectProjectFolder: "Select project folder",
  defaultFolderName: "Default",
  voiceFrequency: "Summary Voice",
  voiceOn: "On",
  voiceOff: "Off",
  voiceAppliesNextSession: "Applies from the next session",
};

const JA: UiStrings = {
  settings: "設定",
  closeSettings: "設定を閉じる",
  language: "言語",
  languageAuto: "自動",
  languageEnglish: "English",
  languageJapanese: "日本語",
  notLoaded: "（未読み込み）",
  loading: "読み込み中...",
  noPacks: "（pack なし）",
  unmuteAmbient: "環境音をミュート解除",
  muteAmbient: "環境音をミュート",
  ambientVolume: "環境音ボリューム",
  selectVrmFile: "VRM ファイルを選択",
  agentAppliesNextLaunch: "※ 次の agent 起動から反映",
  helpPrompt: "/charm:help",
  tutorialPrompt: "/charm:tutorial",
  shortcutPrompt: "/charm:shortcut ショートカットを変更したい",
  createPackPrompt: "/charm:create pack を作りたい",
  pomodoroPrompt: "/charm:help Pomodoro を使いたい",
  selectProjectFolder: "プロジェクトフォルダを選択",
  defaultFolderName: "デフォルト",
  voiceFrequency: "要約読み上げ",
  voiceOn: "On",
  voiceOff: "Off",
  voiceAppliesNextSession: "※ 次のセッションから反映",
};

export function getStrings(language: ResolvedLanguage): UiStrings {
  return language === "ja" ? JA : EN;
}

/**
 * `FixedTerminalPromptKey` → `UiStrings` の対応表。新しい key を
 * `FixedTerminalPromptKey` に足してここに対応を書かないと型エラーになる
 * （無言 no-op を防ぐ網羅性）。設計境界: docs/decisions/input-prefill-boundary.md
 */
const FIXED_PROMPT_STRING: Record<FixedTerminalPromptKey, keyof UiStrings> = {
  help: "helpPrompt",
  tutorial: "tutorialPrompt",
  shortcut: "shortcutPrompt",
  "create-pack": "createPackPrompt",
  pomodoro: "pomodoroPrompt",
};

/**
 * host 所有の固定プロンプトを現在の言語で解決する pure 関数。
 * pack はこの結果を選べない（key → host 所有文字列）。
 */
export function resolveFixedTerminalPrompt(
  key: FixedTerminalPromptKey,
  language: ResolvedLanguage,
): string {
  return getStrings(language)[FIXED_PROMPT_STRING[key]];
}

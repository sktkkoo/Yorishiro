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
  readonly labelPersona: string;
  readonly labelScene: string;
  readonly labelSound: string;
  readonly labelAgent: string;
  readonly labelAura: string;
  readonly labelHealth: string;
  readonly labelPacks: string;
  readonly healthHealthy: string;
  readonly healthWarnings: string;
  readonly healthNeedsAttention: string;
  readonly packHealthy: string;
  readonly packWarnings: string;
  readonly packNeedsAttention: string;
  readonly loadingPacks: string;
  readonly noPacksInstalled: string;
  readonly selectPack: string;
  readonly diagnosing: string;
  readonly quickHelp: string;
  readonly quickTutorial: string;
  readonly quickShortcut: string;
  readonly quickCreatePack: string;
  readonly quickPomodoro: string;
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
  voiceFrequency: "Voice Summary",
  voiceOn: "On",
  voiceOff: "Off",
  voiceAppliesNextSession: "Applies from the next session",
  labelPersona: "Persona",
  labelScene: "Scene",
  labelSound: "Sound",
  labelAgent: "Agent",
  labelAura: "Aura",
  labelHealth: "Health",
  labelPacks: "Packs",
  healthHealthy: "Healthy",
  healthWarnings: "Warnings",
  healthNeedsAttention: "Needs attention",
  packHealthy: "Pack looks healthy",
  packWarnings: "Pack has warnings",
  packNeedsAttention: "Pack needs attention",
  loadingPacks: "Loading packs…",
  noPacksInstalled: "No packs installed",
  selectPack: "Select a pack",
  diagnosing: "Diagnosing…",
  quickHelp: "Help",
  quickTutorial: "Tutorial",
  quickShortcut: "Shortcut",
  quickCreatePack: "Create Pack",
  quickPomodoro: "Pomodoro",
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
  voiceFrequency: "ボイスサマリー",
  voiceOn: "On",
  voiceOff: "Off",
  voiceAppliesNextSession: "※ 次のセッションから反映",
  labelPersona: "ペルソナ",
  labelScene: "シーン",
  labelSound: "サウンド",
  labelAgent: "エージェント",
  labelAura: "オーラ",
  labelHealth: "ヘルス",
  labelPacks: "パック",
  healthHealthy: "正常",
  healthWarnings: "警告あり",
  healthNeedsAttention: "対応が必要",
  packHealthy: "正常",
  packWarnings: "警告あり",
  packNeedsAttention: "対応が必要",
  loadingPacks: "読み込み中…",
  noPacksInstalled: "パックなし",
  selectPack: "パックを選択",
  diagnosing: "診断中…",
  quickHelp: "ヘルプ",
  quickTutorial: "チュートリアル",
  quickShortcut: "ショートカット",
  quickCreatePack: "パック作成",
  quickPomodoro: "ポモドーロ",
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

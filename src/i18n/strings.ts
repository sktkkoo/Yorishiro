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
  readonly terminalAppliesNextLaunch: string;
  readonly shortcutPrompt: string;
  readonly selectProjectFolder: string;
  readonly defaultFolderName: string;
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
  terminalAppliesNextLaunch: "Applies from the next terminal launch",
  shortcutPrompt: "/charm:shortcut I want to change keyboard shortcuts",
  selectProjectFolder: "Select project folder",
  defaultFolderName: "Default",
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
  terminalAppliesNextLaunch: "※ 次の terminal 起動から反映",
  shortcutPrompt: "/charm:shortcut ショートカットを変更したい",
  selectProjectFolder: "プロジェクトフォルダを選択",
  defaultFolderName: "デフォルト",
};

export function getStrings(language: ResolvedLanguage): UiStrings {
  return language === "ja" ? JA : EN;
}

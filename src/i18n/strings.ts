import type { FixedTerminalPromptKey } from "@charminal/sdk";
import type { ChangeStrings } from "../runtime/history/describe-snapshot";
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
  readonly agentControlledByProfile: string;
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
  /** Codex / OpenCode など experimental な agent option の label に付ける suffix。 */
  readonly experimentalAgentSuffix: string;
  readonly labelPresence: string;
  readonly labelAura: string;
  readonly labelHealth: string;
  readonly labelPacks: string;
  readonly labelRestore: string;
  readonly restoreIntro: string;
  readonly restoreEmpty: string;
  readonly restoreLatestTag: string;
  readonly restoreRecommendedTag: string;
  readonly restoreStartupCleanTag: string;
  readonly restoreStartupErrorTag: string;
  readonly restoreButton: string;
  readonly restoreConfirmTitle: string;
  readonly restoreConfirmIntro: string;
  readonly restoreConfirmDetail: string;
  readonly restoreDone: string;
  readonly restoreFailed: string;
  readonly restoreCrashTitle: string;
  readonly restoreCrashIntroPrefix: string;
  readonly restoreCrashRecommendedText: string;
  readonly restoreCrashIntroSuffix: string;
  readonly changedOnePack: string;
  readonly changedManyPacks: string;
  readonly changedConfig: string;
  readonly changedInit: string;
  readonly changedMixed: string;
  readonly changeStartup: string;
  readonly changeManual: string;
  readonly changeUnknown: string;
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
  readonly repairPack: string;
  readonly improvePack: string;
  readonly repairPromptInserted: string;
  readonly quickHelp: string;
  readonly quickTutorial: string;
  readonly quickShortcut: string;
  readonly quickCreatePack: string;
  readonly quickPomodoro: string;
  /** 設定画面 Quick Actions の CREDITS ボタン。overlay の中身は英語固定（ui.tsx）。 */
  readonly labelCredits: string;
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
  agentControlledByProfile: "Launch agent is fixed by defaultProfile",
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
  experimentalAgentSuffix: "experimental",
  labelPresence: "Sidebar",
  labelAura: "Aura",
  labelHealth: "Status",
  labelPacks: "Packs",
  labelRestore: "Restore",
  restoreIntro:
    "Roll ~/.charminal back to an earlier snapshot. Snapshots are taken automatically when you change packs / config.json / init.js. journal is never touched.",
  restoreEmpty: "No snapshots yet.",
  restoreLatestTag: "(current state)",
  restoreRecommendedTag: "★recommended",
  restoreStartupCleanTag: "Started cleanly",
  restoreStartupErrorTag: "Startup error",
  restoreButton: "Restore this",
  restoreConfirmTitle: "Charminal — Confirm restore",
  restoreConfirmIntro: "Restore ~/.charminal to the selected snapshot?",
  restoreConfirmDetail:
    "This full-replaces packs / config.json / init.js and reloads the app (journal is not changed).",
  restoreDone: "Restored to snapshot #{seq}. Reloading…",
  restoreFailed: "Restore failed",
  restoreCrashTitle: "Restore to the state before the latest change",
  restoreCrashIntroPrefix: "If a broken pack caused the crash, restoring to ",
  restoreCrashRecommendedText: "the state before the latest change ({tag})",
  restoreCrashIntroSuffix:
    " can recover Charminal. The latest snapshot is the state after the change, so restoring it may not change the crash. journal is not changed. Restoring config.json / init.js reloads the app.",
  changedOnePack: 'Changed "{id}"',
  changedManyPacks: "Changed {n} packs",
  changedConfig: "Changed settings",
  changedInit: "Changed init.js",
  changedMixed: "{n} changes",
  changeStartup: "At startup",
  changeManual: "Marked by AI",
  changeUnknown: "Changed",
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
  repairPack: "Repair with agent",
  improvePack: "Improve with agent",
  repairPromptInserted: "Repair prompt inserted",
  quickHelp: "Help",
  quickTutorial: "Tutorial",
  quickShortcut: "Shortcut",
  quickCreatePack: "Create Pack",
  quickPomodoro: "Pomodoro",
  labelCredits: "CREDITS",
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
  noPacks: "（パックなし）",
  unmuteAmbient: "環境音をミュート解除",
  muteAmbient: "環境音をミュート",
  ambientVolume: "環境音ボリューム",
  selectVrmFile: "VRM ファイルを選択",
  agentAppliesNextLaunch: "※ 次回起動時に反映",
  agentControlledByProfile: "※ 起動 agent は defaultProfile で固定中",
  helpPrompt: "/charm:help",
  tutorialPrompt: "/charm:tutorial",
  shortcutPrompt: "/charm:shortcut ショートカットを変更したい",
  createPackPrompt: "/charm:create pack を作りたい",
  pomodoroPrompt: "/charm:help Pomodoro を使いたい",
  selectProjectFolder: "プロジェクトフォルダを選択",
  defaultFolderName: "デフォルト",
  voiceFrequency: "Voice Summary",
  voiceOn: "On",
  voiceOff: "Off",
  voiceAppliesNextSession: "※ 次回セッションから反映",
  labelPersona: "Persona",
  labelScene: "Scene",
  labelSound: "Sound",
  labelAgent: "Agent",
  experimentalAgentSuffix: "実験的",
  labelPresence: "Sidebar",
  labelAura: "Aura",
  labelHealth: "Status",
  labelPacks: "Packs",
  labelRestore: "復元",
  restoreIntro:
    "~/.charminal を以前の snapshot に戻します。pack / config.json / init.js を変更すると自動で snapshot が残ります。journal は変更しません。",
  restoreEmpty: "まだ snapshot がありません。",
  restoreLatestTag: "（今の状態）",
  restoreRecommendedTag: "★推奨",
  restoreStartupCleanTag: "起動OK",
  restoreStartupErrorTag: "起動エラー",
  restoreButton: "この状態に戻す",
  restoreConfirmTitle: "Charminal — 復元の確認",
  restoreConfirmIntro: "選んだ snapshot に ~/.charminal を戻しますか？",
  restoreConfirmDetail:
    "packs / config.json / init.js を完全置換し、アプリを再読み込みします（journal は変更しません）。",
  restoreDone: "snapshot #{seq} の状態に戻しました。再読み込みします。",
  restoreFailed: "復元に失敗しました",
  restoreCrashTitle: "最新変更前の状態に戻す",
  restoreCrashIntroPrefix: "壊れた pack が原因なら、",
  restoreCrashRecommendedText: "最新の変更前（{tag}）",
  restoreCrashIntroSuffix:
    "に戻すと復旧できることがあります。最新の snapshot は「変更後＝現在の状態」なので、戻しても症状が変わらない場合があります。journal は変更しません。config.json / init.js を含む復元はアプリを再読み込みします。",
  changedOnePack: "「{id}」を変更",
  changedManyPacks: "{n}個のpackを変更",
  changedConfig: "設定を変更",
  changedInit: "init.js を変更",
  changedMixed: "{n}件の変更",
  changeStartup: "起動時",
  changeManual: "AIが記録",
  changeUnknown: "変更",
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
  repairPack: "AI で修正",
  improvePack: "AI で改善",
  repairPromptInserted: "修正プロンプトを入力済み",
  quickHelp: "ヘルプ",
  quickTutorial: "チュートリアル",
  quickShortcut: "ショートカット",
  quickCreatePack: "パック作成",
  quickPomodoro: "ポモドーロ",
  labelCredits: "CREDITS",
};

export function getStrings(language: ResolvedLanguage): UiStrings {
  return language === "ja" ? JA : EN;
}

/** `UiStrings` のテンプレートを `describeChange` 用の focused interface に変換する。 */
export function changeStrings(s: UiStrings): ChangeStrings {
  return {
    changedOnePack: (id) => s.changedOnePack.replace("{id}", id),
    changedManyPacks: (n) => s.changedManyPacks.replace("{n}", String(n)),
    changedConfig: s.changedConfig,
    changedInit: s.changedInit,
    changedMixed: (n) => s.changedMixed.replace("{n}", String(n)),
    changeStartup: s.changeStartup,
    changeManual: s.changeManual,
    changeUnknown: s.changeUnknown,
  };
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
 * agent ごとの charm コマンド記法。`<prefix>charm<separator><name>` で 1 命令になる。
 * Claude は `/charm:create`、Codex は `$charm-create`、OpenCode は `/charm-create`。
 *
 * 正本は Rust 各 adapter の `command_syntax()`（`list_supported_agents` で公開）。
 * strings.ts は sync / pure 境界なので Tauri call を呼ばず、この表で mirror する。
 * Rust とのズレは health-check の agent-registry drift 検知で surface される。
 * agent を増やすときはこの表に 1 行足すだけでよい（if-chain を散らさない）。
 */
export const AGENT_COMMAND_SYNTAX: Record<
  string,
  { readonly prefix: string; readonly separator: string }
> = {
  claude: { prefix: "/", separator: ":" },
  codex: { prefix: "$", separator: "-" },
  opencode: { prefix: "/", separator: "-" },
};

/** Charminal が prefill する固定プロンプト中に現れる charm コマンド名。 */
const CHARM_COMMAND_NAMES = ["create", "update", "help", "shortcut", "tutorial"] as const;

/** 未知 agent は Claude 記法に fall back する。 */
function charmCommand(name: string, terminalAgent: string): string {
  const syntax = AGENT_COMMAND_SYNTAX[terminalAgent] ?? AGENT_COMMAND_SYNTAX.claude;
  return `${syntax.prefix}charm${syntax.separator}${name}`;
}

function commandPromptForAgent(prompt: string, terminalAgent: string): string {
  // Claude 記法（/charm:<name>）を terminalAgent の記法へ書き換える。claude は no-op。
  return CHARM_COMMAND_NAMES.reduce(
    (acc, name) => acc.split(`/charm:${name}`).join(charmCommand(name, terminalAgent)),
    prompt,
  );
}

function updateCommandForAgent(terminalAgent = "claude"): string {
  return charmCommand("update", terminalAgent);
}

/**
 * host 所有の固定プロンプトを現在の言語で解決する pure 関数。
 * pack はこの結果を選べない（key → host 所有文字列）。
 */
export function resolveFixedTerminalPrompt(
  key: FixedTerminalPromptKey,
  language: ResolvedLanguage,
  terminalAgent = "claude",
): string {
  return commandPromptForAgent(getStrings(language)[FIXED_PROMPT_STRING[key]], terminalAgent);
}

const SAFE_PACK_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function resolvePackRepairPrompt(args: {
  readonly id: string;
  readonly kind?: string;
  readonly action: "repair" | "improve";
  readonly language: ResolvedLanguage;
  readonly terminalAgent?: string;
}): string {
  if (!SAFE_PACK_ID.test(args.id)) throw new Error("invalid pack id");
  if (args.kind !== undefined && !SAFE_PACK_ID.test(args.kind))
    throw new Error("invalid pack kind");
  const kindPart = args.kind ? ` (${args.kind})` : "";
  const command = updateCommandForAgent(args.terminalAgent);
  if (args.language === "ja") {
    const actionText = args.action === "repair" ? "修正" : "改善";
    return `${command} ${args.id}${kindPart} を診断して、${actionText}してください。まず pack_diagnose({ id: "${args.id}" }) で状態を確認してください。`;
  }
  const actionText = args.action === "repair" ? "repair" : "improve";
  return `${command} Diagnose and ${actionText} ${args.id}${kindPart}. Start with pack_diagnose({ id: "${args.id}" }).`;
}

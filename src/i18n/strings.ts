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
  readonly repairPack: string;
  readonly improvePack: string;
  readonly repairPromptInserted: string;
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
  labelAura: "Aura",
  labelHealth: "Status",
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
  repairPack: "Repair with agent",
  improvePack: "Improve with agent",
  repairPromptInserted: "Repair prompt inserted",
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
  labelAura: "Aura",
  labelHealth: "Status",
  labelPacks: "Packs",
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

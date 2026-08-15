import type { FixedTerminalPromptKey } from "@yorishiro/sdk";
import type { RestoreConfirmStrings } from "../components/RestoreConfirmDialog";
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
  readonly unmuteVoice: string;
  readonly muteVoice: string;
  readonly ambientVolume: string;
  readonly voiceVolume: string;
  readonly motionIntensity: string;
  readonly motionLevelCalm: string;
  readonly motionLevelNormal: string;
  readonly motionLevelLively: string;
  readonly motionLevelOver: string;
  readonly selectVrmFile: string;
  readonly vrmChooseAvatar: string;
  readonly vrmDialogTitle: string;
  readonly vrmCloseDialog: string;
  readonly vrmChange: string;
  readonly vrmCurrent: string;
  readonly vrmImportNew: string;
  readonly vrmSearchPlaceholder: string;
  readonly vrmNoMatches: string;
  readonly vrmImportedNotApplied: string;
  readonly vrmImportFailed: string;
  readonly vrmThumbnailAlt: string;
  readonly vrmThumbnailUnavailable: string;
  readonly vrmCatalogIntro: string;
  readonly vrmActive: string;
  readonly vrmPendingSwitch: string;
  readonly vrmInvalid: string;
  readonly vrmMissingBadge: string;
  readonly vrmMissingActive: string;
  readonly vrmMissingRemoved: string;
  readonly vrmCreator: string;
  readonly vrmRemove: string;
  readonly vrmRemoveConfirmTitle: string;
  readonly vrmRemoveConfirmBody: string;
  readonly vrmRemoveConfirm: string;
  readonly vrmRemoveFailed: string;
  readonly vrmRemoved: string;
  readonly vrmApply: string;
  readonly vrmCancel: string;
  readonly vrmApplyDisabledInvalid: string;
  readonly vrmApplyDisabledMissing: string;
  readonly vrmApplyDisabledActive: string;
  readonly vrmRetry: string;
  readonly vrmDetails: string;
  readonly vrmSpec: string;
  readonly vrmName: string;
  readonly vrmVersion: string;
  readonly vrmAuthors: string;
  readonly vrmContact: string;
  readonly vrmReferences: string;
  readonly vrmLicenses: string;
  readonly vrmLicenseName: string;
  readonly vrmLicenseUrls: string;
  readonly vrmThirdPartyLicenses: string;
  readonly vrmUsageConditions: string;
  readonly vrmSummaryHeading: string;
  readonly vrmWhoMayUse: string;
  readonly vrmContentRestrictions: string;
  readonly vrmMoreDetails: string;
  readonly vrmRestrictionsBlocked: string;
  readonly vrmRestrictionsAllowed: string;
  readonly vrmRestrictionsUnstated: string;
  readonly vrmRestrictionViolence: string;
  readonly vrmRestrictionSexual: string;
  readonly vrmRestrictionPolitical: string;
  readonly vrmRestrictionAntisocial: string;
  readonly vrmAllowedUser: string;
  readonly vrmAvatarPermission: string;
  readonly vrmViolentUsage: string;
  readonly vrmSexualUsage: string;
  readonly vrmCommercialUsage: string;
  readonly vrmPoliticalUsage: string;
  readonly vrmAntisocialUsage: string;
  readonly vrmRedistribution: string;
  readonly vrmModification: string;
  readonly vrmCredit: string;
  readonly vrmNotSpecified: string;
  readonly vrmUnknown: string;
  readonly vrmPermissionAllowed: string;
  readonly vrmPermissionDisallowed: string;
  readonly vrmPermissionOnlyAuthor: string;
  readonly vrmPermissionExplicitlyLicensedPerson: string;
  readonly vrmPermissionEveryone: string;
  readonly vrmPermissionPersonalNonProfit: string;
  readonly vrmPermissionPersonalProfit: string;
  readonly vrmPermissionCorporation: string;
  readonly vrmPermissionProhibited: string;
  readonly vrmPermissionRequired: string;
  readonly vrmPermissionUnnecessary: string;
  readonly vrmPermissionAllowModification: string;
  readonly vrmPermissionAllowModificationRedistribution: string;
  readonly vrmDefaultAvatar: string;
  readonly vrmYoriAuthor: string;
  readonly vrmYoriUseWithinApp: string;
  readonly vrmYoriAvatarPerformance: string;
  readonly vrmYoriStandaloneReuse: string;
  readonly vrmYoriViolentExpression: string;
  readonly vrmYoriSexualExpression: string;
  readonly vrmLoadingFailed: string;
  readonly agentControlledByProfile: string;
  readonly helpPrompt: string;
  readonly tutorialPrompt: string;
  readonly shortcutPrompt: string;
  readonly createPackPrompt: string;
  readonly pomodoroPrompt: string;
  readonly selectProjectFolder: string;
  readonly defaultFolderName: string;
  readonly newConversation: string;
  readonly backConversation: string;
  readonly noBackConversation: string;
  readonly forwardConversation: string;
  readonly noForwardConversation: string;
  readonly switchingConversation: string;
  readonly voiceFrequency: string;
  readonly voiceOn: string;
  readonly voiceOff: string;
  /**
   * GPT Live 音声会話ボタンの tooltip / aria-label。ユーザー向け文言は provider
   * （Codex）ではなく「GPT Liveの音声会話」で統一する。
   */
  readonly gptLiveVoiceStart: string;
  readonly gptLiveVoiceStop: string;
  readonly gptLiveVoiceConnecting: string;
  readonly gptLiveVoiceRetry: string;
  readonly gptLiveRequiresCodex: string;
  readonly gptLiveSwitchBody: string;
  readonly gptLiveSetupBody: string;
  readonly gptLiveCancel: string;
  readonly gptLiveConfirmSwitch: string;
  readonly gptLiveOpenSettings: string;
  /**
   * セッション再起動を伴う設定変更の確認ダイアログ。「セッション」というシステム語
   * ではなく会話の行き先を伝える：persona は新しく始まる（引き継がない）、agent は
   * 区切り（戻れば続きから）、voice は継続。ボタンは generic な「続ける」でなく操作の
   * 動詞。お別れの儀式は新規ペルソナ作成時の goodbye switch（MCP 経路）だけで、
   * 既存ペルソナ間の切替は軽い確認に留める。{current} / {next} は表示名で置換する。
   */
  readonly personaSwitchConfirm: string;
  readonly personaSwitchConfirmButton: string;
  readonly agentSwitchConfirm: string;
  readonly agentSwitchConfirmButton: string;
  readonly voiceRestartConfirm: string;
  readonly voiceRestartConfirmButton: string;
  readonly labelPersona: string;
  readonly labelScene: string;
  readonly labelAgent: string;
  readonly labelPresence: string;
  readonly labelAura: string;
  readonly labelAttentionLight: string;
  readonly labelTabBadges: string;
  readonly labelHealth: string;
  readonly labelPacks: string;
  readonly labelRestore: string;
  readonly restoreIntro: string;
  readonly restoreEmpty: string;
  readonly restoreLatestTag: string;
  readonly restoreRecommendedTag: string;
  readonly restoreButton: string;
  readonly restoreConfirmTitle: string;
  readonly restoreConfirmIntro: string;
  readonly restoreConfirmDetail: string;
  readonly restoreConfirmBody: string;
  readonly restoreConfirmButton: string;
  readonly restoreConfirmCancel: string;
  readonly restoreConfirmRestoring: string;
  readonly restoreConfirmDone: string;
  readonly restoreConfirmClose: string;
  readonly restoreConfirmRetry: string;
  readonly restoreDone: string;
  readonly restoreFailed: string;
  readonly restoreCrashTitle: string;
  readonly restoreCrashIntroPrefix: string;
  readonly restoreCrashRecommendedText: string;
  readonly restoreCrashIntroSuffix: string;
  readonly changedOnePack: string;
  readonly changedManyPacks: string;
  readonly changedManyPacksNamed: string;
  readonly changedManyPacksNamedMore: string;
  readonly changedConfig: string;
  readonly changedInit: string;
  readonly changedMixed: string;
  readonly changeStartup: string;
  readonly changeStartupError: string;
  readonly changeManual: string;
  readonly changePreRestore: string;
  readonly changeSdkSnapshot: string;
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
  /** 設定画面の更新バナー。{version} を新 version で置換する。 */
  readonly updateAvailable: string;
  readonly updateAndRestart: string;
  readonly updateDownloading: string;
  readonly updateFailed: string;
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
  unmuteVoice: "Unmute voice",
  muteVoice: "Mute voice",
  ambientVolume: "Ambience",
  voiceVolume: "Voice",
  motionIntensity: "Motion Intensity",
  motionLevelCalm: "Calm",
  motionLevelNormal: "Normal",
  motionLevelLively: "Lively",
  motionLevelOver: "Over-the-top",
  selectVrmFile: "Select VRM file",
  vrmChooseAvatar: "Choose avatar",
  vrmDialogTitle: "Change avatar",
  vrmCloseDialog: "Close avatar chooser",
  vrmChange: "Change…",
  vrmCurrent: "Current",
  vrmImportNew: "Add from file…",
  vrmSearchPlaceholder: "Search by name or author",
  vrmNoMatches: "No matching avatars",
  vrmImportedNotApplied: "Added to the list.",
  vrmImportFailed: "Could not add the VRM file.",
  vrmThumbnailAlt: "Thumbnail of {name}",
  vrmThumbnailUnavailable: "No thumbnail available",
  vrmCatalogIntro: '"Not stated" is not permission. The decision is yours.',
  vrmActive: "Active",
  vrmPendingSwitch: "Switch {from} → {to}",
  vrmInvalid: "Invalid",
  vrmMissingBadge: "Missing",
  vrmMissingActive: "The active VRM is missing from the avatar folder.",
  vrmMissingRemoved: "{name} was not found and was removed from the list.",
  vrmCreator: "Creator",
  vrmRemove: "Remove from list…",
  vrmRemoveConfirmTitle: "Remove from the list?",
  vrmRemoveConfirmBody:
    "{name} will be removed from Yorishiro's list. The original VRM file you selected will not be deleted.",
  vrmRemoveConfirm: "Remove from list",
  vrmRemoveFailed: "Could not remove the avatar from the list.",
  vrmRemoved: "Removed {name} from the list.",
  vrmApply: "Switch to this avatar",
  vrmCancel: "Cancel",
  vrmApplyDisabledInvalid: "This file cannot be applied because it is invalid.",
  vrmApplyDisabledMissing: "A missing avatar cannot be applied.",
  vrmApplyDisabledActive: "This avatar is already active.",
  vrmRetry: "Retry",
  vrmDetails: "Avatar details",
  vrmSpec: "VRM spec",
  vrmName: "Name",
  vrmVersion: "Version",
  vrmAuthors: "Authors",
  vrmContact: "Contact",
  vrmReferences: "References",
  vrmLicenses: "License information",
  vrmLicenseName: "License name",
  vrmLicenseUrls: "License / permission URLs",
  vrmThirdPartyLicenses: "Third-party licenses",
  vrmUsageConditions: "Usage conditions",
  vrmSummaryHeading: "Key usage terms",
  vrmWhoMayUse: "Who may use it",
  vrmContentRestrictions: "Content restrictions",
  vrmMoreDetails: "More details",
  vrmRestrictionsBlocked: "Not allowed",
  vrmRestrictionsAllowed: "Allowed",
  vrmRestrictionsUnstated: "Not stated",
  vrmRestrictionViolence: "violence",
  vrmRestrictionSexual: "sexual content",
  vrmRestrictionPolitical: "political / religious use",
  vrmRestrictionAntisocial: "antisocial / hate use",
  vrmAllowedUser: "Allowed user (VRM 0.x)",
  vrmAvatarPermission: "Avatar permission (VRM 1.0)",
  vrmViolentUsage: "Violent usage",
  vrmSexualUsage: "Sexual usage",
  vrmCommercialUsage: "Commercial usage",
  vrmPoliticalUsage: "Political / religious usage",
  vrmAntisocialUsage: "Antisocial / hate usage",
  vrmRedistribution: "Redistribution",
  vrmModification: "Modification",
  vrmCredit: "Credit notation",
  vrmNotSpecified: "Not stated",
  vrmUnknown: "Unknown (not treated as permission)",
  vrmPermissionAllowed: "Allowed",
  vrmPermissionDisallowed: "Not allowed",
  vrmPermissionOnlyAuthor: "Only the author",
  vrmPermissionExplicitlyLicensedPerson: "Explicitly licensed persons only",
  vrmPermissionEveryone: "Everyone",
  vrmPermissionPersonalNonProfit: "Personal, non-profit use",
  vrmPermissionPersonalProfit: "Personal commercial use",
  vrmPermissionCorporation: "Corporate commercial use",
  vrmPermissionProhibited: "Prohibited",
  vrmPermissionRequired: "Required",
  vrmPermissionUnnecessary: "Not required",
  vrmPermissionAllowModification: "Modification allowed",
  vrmPermissionAllowModificationRedistribution: "Modification and redistribution allowed",
  vrmDefaultAvatar: "Default avatar",
  vrmYoriAuthor: "LUCAS",
  vrmYoriUseWithinApp: "Use within Yorishiro is permitted for everyone.",
  vrmYoriAvatarPerformance: "Performing as the avatar is limited to explicitly licensed persons.",
  vrmYoriStandaloneReuse: "Standalone redistribution or reuse of the model is prohibited.",
  vrmYoriViolentExpression: "Violent expression is permitted.",
  vrmYoriSexualExpression: "Sexual expression is prohibited.",
  vrmLoadingFailed: "Could not load the avatar catalog.",
  agentControlledByProfile: "Launch agent is fixed by defaultProfile",
  helpPrompt: "/yori:help",
  tutorialPrompt: "/yori:tutorial",
  shortcutPrompt: "/yori:shortcut I want to change keyboard shortcuts",
  createPackPrompt: "/yori:create I want to create a pack",
  pomodoroPrompt: "/yori:help I want to use Pomodoro",
  selectProjectFolder: "Select project folder",
  defaultFolderName: "~",
  newConversation: "New session",
  backConversation: "Back to previous session",
  noBackConversation: "No previous session",
  forwardConversation: "Forward to next session",
  noForwardConversation: "No next session",
  switchingConversation: "Switching sessions…",
  voiceFrequency: "Voice Summary",
  voiceOn: "On",
  voiceOff: "Off",
  gptLiveVoiceStart: "Start GPT Live voice conversation",
  gptLiveVoiceStop: "Stop GPT Live voice conversation",
  gptLiveVoiceConnecting: "Connecting GPT Live voice conversation… (click to cancel)",
  gptLiveVoiceRetry: "Retry GPT Live voice conversation",
  gptLiveRequiresCodex: "Voice conversation (GPT Live) currently requires Codex",
  gptLiveSwitchBody:
    "Your current Main Agent does not support voice conversation. Switch to Codex and start a voice conversation? Your current conversation and work state are preserved, and switching back to the original agent resumes where you left off.",
  gptLiveSetupBody:
    "Install the Codex CLI and sign in with ChatGPT (or configure an API key), then open Settings to select Codex as the Main Agent.",
  gptLiveCancel: "Cancel",
  gptLiveConfirmSwitch: "Switch and start",
  gptLiveOpenSettings: "Open Settings",
  personaSwitchConfirm: "Switch to {next}. The conversation starts fresh.",
  personaSwitchConfirmButton: "Switch",
  agentSwitchConfirm:
    "Switch the Main Agent to {next} and restart the session. The conversation with {current} pauses here — switching back resumes it.",
  agentSwitchConfirmButton: "Switch",
  voiceRestartConfirm:
    "Restart the session to apply. The conversation continues where it left off.",
  voiceRestartConfirmButton: "Restart",
  labelPersona: "Persona",
  labelScene: "Scene",
  labelAgent: "Main Agent",
  labelPresence: "Sidebar",
  labelAura: "Aura",
  labelAttentionLight: "Light Alert",
  labelTabBadges: "Tab badges",
  labelHealth: "Status",
  labelPacks: "Packs",
  labelRestore: "Restore (Pack / init.js)",
  restoreIntro:
    "Restore packs and startup scripts to a previous state. Your project files are not affected. Checkpoints are created automatically when packs or init.js change.",
  restoreEmpty: "No restore points yet.",
  restoreLatestTag: "(current state)",
  restoreRecommendedTag: "★recommended",
  restoreButton: "Restore this",
  restoreConfirmTitle: "Restore to this point?",
  restoreConfirmIntro: "Restore Yorishiro to the selected point?",
  restoreConfirmDetail:
    "This restores Yorishiro to that point in time. Packs, settings, and startup behavior return to that point, and the app reloads.",
  restoreConfirmBody:
    "Restore to {change} ({time}). Packs, settings, and startup behavior return to that point, and the app reloads.",
  restoreConfirmButton: "Restore",
  restoreConfirmCancel: "Cancel",
  restoreConfirmRestoring: "Restoring...",
  restoreConfirmDone: "Restored. Reloading...",
  restoreConfirmClose: "Close",
  restoreConfirmRetry: "Retry",
  restoreDone: "Restored. Reloading…",
  restoreFailed: "Restore failed",
  restoreCrashTitle: "Restore to the state before the latest change",
  restoreCrashIntroPrefix: "If the last change caused the crash, restoring to ",
  restoreCrashRecommendedText: "the state before the latest change ({tag})",
  restoreCrashIntroSuffix:
    " can recover Yorishiro. The latest point is the current state, so restoring it may not change the crash. Restoring reloads the app.",
  changedOnePack: 'Changed "{id}"',
  changedManyPacks: "{n} changes",
  changedManyPacksNamed: 'Changed "{names}"',
  changedManyPacksNamedMore: 'Changed "{first}" + {rest} more',
  changedConfig: "Changed settings",
  changedInit: "Changed startup behavior",
  changedMixed: "{n} changes",
  changeStartup: "Startup checkpoint",
  changeStartupError: "Startup checkpoint (error)",
  changeManual: "Marked by AI",
  changePreRestore: "Restored to {time}",
  changeSdkSnapshot: "Recorded by pack",
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
  updateAvailable: "v{version} available",
  updateAndRestart: "Update and restart",
  updateDownloading: "Updating…",
  updateFailed: "Update failed. Please try again later.",
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
  unmuteVoice: "音声のミュートを解除",
  muteVoice: "音声をミュート",
  ambientVolume: "環境音",
  voiceVolume: "音声",
  motionIntensity: "Motion Intensity",
  motionLevelCalm: "控えめ",
  motionLevelNormal: "標準",
  motionLevelLively: "活発",
  motionLevelOver: "オーバー",
  selectVrmFile: "VRM ファイルを選択",
  vrmChooseAvatar: "アバターを選ぶ",
  vrmDialogTitle: "アバターを変更",
  vrmCloseDialog: "アバター選択を閉じる",
  vrmChange: "変更…",
  vrmCurrent: "現在",
  vrmImportNew: "ファイルを追加…",
  vrmSearchPlaceholder: "名前・制作者で検索",
  vrmNoMatches: "該当するアバターはありません",
  vrmImportedNotApplied: "一覧に追加しました。",
  vrmImportFailed: "VRM ファイルを追加できませんでした。",
  vrmThumbnailAlt: "{name} のサムネイル",
  vrmThumbnailUnavailable: "サムネイルはありません",
  vrmCatalogIntro: "「記載なし」は許可を意味しません。最終的な判断は利用者が行います。",
  vrmActive: "使用中",
  vrmPendingSwitch: "{from} → {to} に切り替えます",
  vrmInvalid: "無効",
  vrmMissingBadge: "見つかりません",
  vrmMissingActive: "使用中の VRM がアバターフォルダに見つかりません。",
  vrmMissingRemoved: "{name} が見つからなかったため、一覧から削除しました。",
  vrmCreator: "作者",
  vrmRemove: "一覧から削除…",
  vrmRemoveConfirmTitle: "一覧から削除しますか？",
  vrmRemoveConfirmBody:
    "{name} を Yorishiro の一覧から削除します。読み込み元の VRM ファイルは削除されません。",
  vrmRemoveConfirm: "一覧から削除",
  vrmRemoveFailed: "アバターを一覧から削除できませんでした。",
  vrmRemoved: "{name} を一覧から削除しました。",
  vrmApply: "このアバターに切り替える",
  vrmCancel: "キャンセル",
  vrmApplyDisabledInvalid: "無効なファイルのため適用できません。",
  vrmApplyDisabledMissing: "見つからないアバターは適用できません。",
  vrmApplyDisabledActive: "このアバターは現在使用中です。",
  vrmRetry: "再試行",
  vrmDetails: "アバターの詳細",
  vrmSpec: "VRM 仕様",
  vrmName: "名前",
  vrmVersion: "バージョン",
  vrmAuthors: "制作者",
  vrmContact: "連絡先",
  vrmReferences: "参照情報",
  vrmLicenses: "ライセンス情報",
  vrmLicenseName: "ライセンス名",
  vrmLicenseUrls: "ライセンス・許諾 URL",
  vrmThirdPartyLicenses: "第三者ライセンス",
  vrmUsageConditions: "利用条件",
  vrmSummaryHeading: "利用条件の要点",
  vrmWhoMayUse: "利用できる人",
  vrmContentRestrictions: "表現の制限",
  vrmMoreDetails: "詳細情報",
  vrmRestrictionsBlocked: "不許可",
  vrmRestrictionsAllowed: "許可",
  vrmRestrictionsUnstated: "記載なし",
  vrmRestrictionViolence: "暴力表現",
  vrmRestrictionSexual: "性的表現",
  vrmRestrictionPolitical: "政治・宗教目的",
  vrmRestrictionAntisocial: "反社会・憎悪表現",
  vrmAllowedUser: "利用可能なユーザー（VRM 0.x）",
  vrmAvatarPermission: "アバター利用権限（VRM 1.0）",
  vrmViolentUsage: "暴力表現での利用",
  vrmSexualUsage: "性的表現での利用",
  vrmCommercialUsage: "商用利用",
  vrmPoliticalUsage: "政治・宗教目的での利用",
  vrmAntisocialUsage: "反社会・憎悪表現での利用",
  vrmRedistribution: "再配布",
  vrmModification: "改変",
  vrmCredit: "クレジット表記",
  vrmNotSpecified: "記載なし",
  vrmUnknown: "不明（許可として扱いません）",
  vrmPermissionAllowed: "許可",
  vrmPermissionDisallowed: "不許可",
  vrmPermissionOnlyAuthor: "作者本人のみ",
  vrmPermissionExplicitlyLicensedPerson: "明示的に許諾された人のみ",
  vrmPermissionEveryone: "全員",
  vrmPermissionPersonalNonProfit: "個人・非営利利用",
  vrmPermissionPersonalProfit: "個人の営利利用",
  vrmPermissionCorporation: "法人の営利利用",
  vrmPermissionProhibited: "禁止",
  vrmPermissionRequired: "必須",
  vrmPermissionUnnecessary: "不要",
  vrmPermissionAllowModification: "改変を許可",
  vrmPermissionAllowModificationRedistribution: "改変と再配布を許可",
  vrmDefaultAvatar: "標準アバター",
  vrmYoriAuthor: "LUCAS",
  vrmYoriUseWithinApp: "Yorishiro 内での使用は、すべての人に許可されています。",
  vrmYoriAvatarPerformance: "アバターとして演じることは、明示的に許諾された人に限られます。",
  vrmYoriStandaloneReuse: "モデル単体の再配布・再利用は禁止されています。",
  vrmYoriViolentExpression: "暴力表現での使用は許可されています。",
  vrmYoriSexualExpression: "性的表現での使用は禁止されています。",
  vrmLoadingFailed: "アバター一覧を読み込めませんでした。",
  agentControlledByProfile: "※ 起動 agent は defaultProfile で固定中",
  helpPrompt: "/yori:help",
  tutorialPrompt: "/yori:tutorial",
  shortcutPrompt: "/yori:shortcut ショートカットを変更したい",
  createPackPrompt: "/yori:create pack を作りたい",
  pomodoroPrompt: "/yori:help Pomodoro を使いたい",
  selectProjectFolder: "プロジェクトフォルダを選択",
  defaultFolderName: "~",
  newConversation: "新しいセッション",
  backConversation: "前のセッションに戻る",
  noBackConversation: "戻れるセッションはありません",
  forwardConversation: "次のセッションに進む",
  noForwardConversation: "進めるセッションはありません",
  switchingConversation: "セッションを切り替え中…",
  voiceFrequency: "Voice Summary",
  voiceOn: "On",
  voiceOff: "Off",
  gptLiveVoiceStart: "GPT Liveの音声会話を始める",
  gptLiveVoiceStop: "GPT Liveの音声会話を終了",
  gptLiveVoiceConnecting: "GPT Liveの音声会話に接続中…（クリックで中止）",
  gptLiveVoiceRetry: "GPT Liveの音声会話を再試行",
  gptLiveRequiresCodex: "音声会話（GPT Live）の利用には、現在Codexが必要です",
  gptLiveSwitchBody:
    "現在のメインエージェントは音声会話に対応していません。Codexへ切り替えて、音声会話を始めますか？現在の会話と作業状態は保持され、元のエージェントへ戻すと続きから再開できます。",
  gptLiveSetupBody:
    "Codex CLIをインストールし、ChatGPTでサインイン（またはAPIキーを設定）してから、SettingsでMain AgentにCodexを選んでください。",
  gptLiveCancel: "キャンセル",
  gptLiveConfirmSwitch: "切り替えて開始",
  gptLiveOpenSettings: "Settingsを開く",
  personaSwitchConfirm: "{next} に切り替えます。会話は新しく始まります。",
  personaSwitchConfirmButton: "切り替える",
  agentSwitchConfirm:
    "Main Agent を {next} に切り替えて再起動します。{current} との会話はいったん区切りになります（戻すと続きから再開できます）",
  agentSwitchConfirmButton: "切り替える",
  voiceRestartConfirm: "反映のためにセッションを再起動します。会話は続きから再開します。",
  voiceRestartConfirmButton: "再起動する",
  labelPersona: "Persona",
  labelScene: "Scene",
  labelAgent: "Main Agent",
  labelPresence: "Sidebar",
  labelAura: "Aura",
  labelAttentionLight: "Light Alert",
  labelTabBadges: "Tab badges",
  labelHealth: "Status",
  labelPacks: "Packs",
  labelRestore: "復元（Pack / init.js）",
  restoreIntro:
    "パックや起動スクリプトを以前の状態に戻せます。プロジェクトのファイルには影響しません。チェックポイントはパックや init.js の変更時に自動で作られます。",
  restoreEmpty: "まだ戻せる地点がありません。",
  restoreLatestTag: "（今の状態）",
  restoreRecommendedTag: "★推奨",
  restoreButton: "この状態に戻す",
  restoreConfirmTitle: "この時点に戻しますか？",
  restoreConfirmIntro: "選んだ時点に戻しますか？",
  restoreConfirmDetail:
    "この時点の状態に戻します。パック・設定・起動時の動作がその時点に戻り、アプリを再読み込みします。",
  restoreConfirmBody:
    "{change}（{time}）に戻します。パック・設定・起動時の動作がその時点に戻り、アプリを再読み込みします。",
  restoreConfirmButton: "戻す",
  restoreConfirmCancel: "やめる",
  restoreConfirmRestoring: "戻しています...",
  restoreConfirmDone: "戻しました。再読み込みします...",
  restoreConfirmClose: "閉じる",
  restoreConfirmRetry: "再試行",
  restoreDone: "戻しました。再読み込みします。",
  restoreFailed: "復元に失敗しました",
  restoreCrashTitle: "最新変更前の状態に戻す",
  restoreCrashIntroPrefix: "直前の変更が原因なら、",
  restoreCrashRecommendedText: "最新の変更前（{tag}）",
  restoreCrashIntroSuffix:
    "に戻すと復旧できることがあります。最新の時点は「変更後＝現在の状態」なので、戻しても症状が変わらない場合があります。復元するとアプリを再読み込みします。",
  changedOnePack: "「{id}」を変更",
  changedManyPacks: "{n}個の変更",
  changedManyPacksNamed: "「{names}」を変更",
  changedManyPacksNamedMore: "「{first}」ほか{rest}件を変更",
  changedConfig: "設定を変更",
  changedInit: "起動時の動作を変更",
  changedMixed: "{n}件の変更",
  changeStartup: "起動時チェックポイント",
  changeStartupError: "起動時チェックポイント（エラー）",
  changeManual: "AIが記録",
  changePreRestore: "{time} の状態に復元",
  changeSdkSnapshot: "packが記録",
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
  updateAvailable: "v{version} が利用可能です",
  updateAndRestart: "更新して再起動",
  updateDownloading: "更新中…",
  updateFailed: "更新に失敗しました。時間をおいて再試行してください。",
};

export function getStrings(language: ResolvedLanguage): UiStrings {
  return language === "ja" ? JA : EN;
}

/** `UiStrings` のテンプレートを `describeChange` 用の focused interface に変換する。 */
export function changeStrings(s: UiStrings): ChangeStrings {
  return {
    changedOnePack: (id) => s.changedOnePack.replace("{id}", id),
    changedManyPacks: (n) => s.changedManyPacks.replace("{n}", String(n)),
    changedManyPacksNamed: (names) => {
      if (names.length <= 2) {
        const joined = names.map((n) => s.changedOnePack.replace("{id}", n)).join("、");
        return joined;
      }
      return s.changedManyPacksNamedMore
        .replace("{first}", names[0])
        .replace("{rest}", String(names.length - 1));
    },
    changedConfig: s.changedConfig,
    changedInit: s.changedInit,
    changedMixed: (n) => s.changedMixed.replace("{n}", String(n)),
    changeStartup: s.changeStartup,
    changeStartupError: s.changeStartupError,
    changeManual: s.changeManual,
    changePreRestore: (time) => s.changePreRestore.replace("{time}", time),
    changeSdkSnapshot: s.changeSdkSnapshot,
    changeUnknown: s.changeUnknown,
  };
}

/** `UiStrings` から restore confirm overlay 用の focused interface を作る。 */
export function restoreConfirmStrings(s: UiStrings): RestoreConfirmStrings {
  return {
    title: s.restoreConfirmTitle,
    body: s.restoreConfirmBody,
    cancel: s.restoreConfirmCancel,
    confirm: s.restoreConfirmButton,
    restoring: s.restoreConfirmRestoring,
    done: s.restoreConfirmDone,
    failed: s.restoreFailed,
    close: s.restoreConfirmClose,
    retry: s.restoreConfirmRetry,
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
 * agent ごとの yori コマンド記法。`<prefix>yori<separator><name>` で 1 命令になる。
 * Claude は `/yori:create`、Codex は `$yori-create`、OpenCode は `/yori-create`。
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

/** Yorishiro が prefill する固定プロンプト中に現れる yori コマンド名。 */
const YORI_COMMAND_NAMES = ["create", "update", "help", "shortcut", "tutorial"] as const;

/** 未知 agent は Claude 記法に fall back する。 */
function yoriCommand(name: string, terminalAgent: string): string {
  const syntax = AGENT_COMMAND_SYNTAX[terminalAgent] ?? AGENT_COMMAND_SYNTAX.claude;
  return `${syntax.prefix}yori${syntax.separator}${name}`;
}

function commandPromptForAgent(prompt: string, terminalAgent: string): string {
  // Claude 記法（/yori:<name>）を terminalAgent の記法へ書き換える。claude は no-op。
  return YORI_COMMAND_NAMES.reduce(
    (acc, name) => acc.split(`/yori:${name}`).join(yoriCommand(name, terminalAgent)),
    prompt,
  );
}

function updateCommandForAgent(terminalAgent = "claude"): string {
  return yoriCommand("update", terminalAgent);
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

import {
  ChevronDown,
  LoaderCircle,
  Mic,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { MediaPermissionHelp } from "./media-permission-help";
import type { VoiceApproval } from "./runtime/codex-realtime/voice-approval";
import { getMediaPermissionKind } from "./runtime/media-permissions";
import type { UiPackEntry } from "./runtime/ui-pack-registry";

/**
 * GPT Live 音声会話ボタンの表示状態。会話状態は realtime client の status を写し、
 * 赤丸だけは独立した MediaStreamTrack の capture liveness を写す。
 * スラッシュ付きマイク（MicOff）は「マイクのミュート」を意味する慣習アイコンの
 * ため、会話が生きている active 状態には使わない。ユーザー操作によるミュートが
 * 実装されるまでは MicOff をこのボタンに登場させないこと。
 */
export type VoiceControlState = "idle" | "connecting" | "active" | "error";

export interface TitleBarProps {
  readonly onToggleSidebar: () => void;
  readonly onOpenSettings: () => void;
  readonly sidebarOpen: boolean;
  readonly settingsActive: boolean;
  readonly settingsLabel: string;
  readonly sidebarLabel: string;
  readonly viewModeLabel: string;
  readonly terminalLabel: string;
  readonly terminalShortcutHint?: string;
  readonly settingsShortcutHint: string;
  readonly viewModeShortcutHints?: Readonly<Record<string, string>>;
  readonly showSidebarToggle?: boolean;
  readonly voiceAvailable?: boolean;
  readonly voiceDisabled?: boolean;
  readonly voiceState?: VoiceControlState;
  /** Browser-owned microphone capture liveness, independent of the conversation status. */
  readonly voiceMicrophoneActive?: boolean;
  readonly voiceLabel?: string;
  readonly voiceError?: string;
  readonly voiceApproval?: VoiceApproval;
  readonly voiceApprovalEnabled?: boolean;
  readonly onToggleVoiceApproval?: () => void;
  readonly language?: string;
  readonly onToggleVoice?: () => void;
  readonly screenSharingControl?: ReactNode;
  readonly tabs?: ReactNode;
  readonly viewModes?: ReadonlyArray<UiPackEntry>;
  readonly activeViewModeId?: string | null;
  readonly onSelectViewMode?: (id: string | null) => void;
}

export default function TitleBar({
  onToggleSidebar,
  onOpenSettings,
  sidebarOpen,
  settingsActive,
  settingsLabel,
  sidebarLabel,
  viewModeLabel,
  terminalLabel,
  terminalShortcutHint,
  settingsShortcutHint,
  viewModeShortcutHints = {},
  showSidebarToggle = true,
  voiceAvailable = false,
  voiceDisabled = false,
  voiceState = "idle",
  voiceMicrophoneActive = false,
  voiceLabel = "",
  voiceError,
  voiceApproval,
  voiceApprovalEnabled = false,
  onToggleVoiceApproval,
  language,
  onToggleVoice,
  screenSharingControl,
  tabs,
  viewModes = [],
  activeViewModeId = null,
  onSelectViewMode,
}: TitleBarProps) {
  const japanese = language === "ja";
  const approvalVisible = voiceState === "active" && voiceApprovalEnabled && !!voiceApproval;
  const permissionKind = getMediaPermissionKind(voiceError);
  const SidebarIcon = sidebarOpen ? PanelLeftClose : PanelLeftOpen;
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const pickerButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusMenuItem = (edge: "first" | "last") => {
    requestAnimationFrame(() => {
      const items = menuRef.current?.querySelectorAll<HTMLButtonElement>("button");
      items?.[edge === "first" ? 0 : items.length - 1]?.focus();
    });
  };
  useEffect(() => {
    if (!pickerOpen) return;
    const close = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [pickerOpen]);

  return (
    <header className="title-bar" data-voice-approval={approvalVisible} data-tauri-drag-region="">
      <div className="title-bar-controls">
        {showSidebarToggle ? (
          <button
            type="button"
            className="title-bar-button title-bar-sidebar-button"
            onClick={onToggleSidebar}
            aria-label={sidebarLabel}
            aria-pressed={sidebarOpen}
            title={sidebarLabel}
          >
            <SidebarIcon size={15} strokeWidth={1.8} aria-hidden="true" />
          </button>
        ) : null}
        <div className="view-mode-control" ref={pickerRef}>
          <button
            ref={pickerButtonRef}
            type="button"
            className={`title-bar-button${pickerOpen ? " is-active" : ""}`}
            aria-label={viewModeLabel}
            aria-haspopup="menu"
            aria-expanded={pickerOpen}
            title={viewModeLabel}
            onClick={() => setPickerOpen((open) => !open)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setPickerOpen(true);
                focusMenuItem(event.key === "ArrowDown" ? "first" : "last");
              } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setPickerOpen((open) => {
                  if (!open) focusMenuItem("first");
                  return !open;
                });
              } else if (event.key === "Escape") {
                event.preventDefault();
                setPickerOpen(false);
              }
            }}
          >
            <Monitor size={15} strokeWidth={1.8} aria-hidden="true" />
            <ChevronDown size={9} aria-hidden="true" />
          </button>
          {pickerOpen ? (
            <div
              className="view-mode-menu"
              ref={menuRef}
              role="menu"
              aria-label={viewModeLabel}
              onKeyDown={(event) => {
                const items = [
                  ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
                ];
                const index = items.indexOf(document.activeElement as HTMLButtonElement);
                if (event.key === "Escape") {
                  event.preventDefault();
                  setPickerOpen(false);
                  pickerButtonRef.current?.focus();
                } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const delta = event.key === "ArrowDown" ? 1 : -1;
                  items[(index + delta + items.length) % items.length]?.focus();
                } else if (event.key === "Home" || event.key === "End") {
                  event.preventDefault();
                  items[event.key === "Home" ? 0 : items.length - 1]?.focus();
                }
              }}
            >
              <button
                type="button"
                role="menuitemradio"
                aria-label={
                  terminalShortcutHint
                    ? `${terminalLabel} (${terminalShortcutHint})`
                    : terminalLabel
                }
                aria-checked={activeViewModeId === null}
                onClick={() => {
                  onSelectViewMode?.(null);
                  setPickerOpen(false);
                }}
              >
                <span>{terminalLabel}</span>
                {terminalShortcutHint ? <kbd>{terminalShortcutHint}</kbd> : null}
              </button>
              {viewModes.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="menuitemradio"
                  aria-label={
                    viewModeShortcutHints[entry.id]
                      ? `${entry.manifest.viewMode?.label ?? entry.manifest.name ?? entry.id} (${viewModeShortcutHints[entry.id]})`
                      : undefined
                  }
                  aria-checked={activeViewModeId === entry.id}
                  onClick={() => {
                    onSelectViewMode?.(entry.id);
                    setPickerOpen(false);
                  }}
                >
                  <span>{entry.manifest.viewMode?.label ?? entry.manifest.name ?? entry.id}</span>
                  {viewModeShortcutHints[entry.id] ? (
                    <kbd>{viewModeShortcutHints[entry.id]}</kbd>
                  ) : null}
                </button>
              ))}
              <hr className="view-mode-menu-separator" />
              <button
                type="button"
                role="menuitem"
                aria-label={`${settingsLabel} (${settingsShortcutHint})`}
                onClick={() => {
                  onOpenSettings();
                  setPickerOpen(false);
                }}
              >
                <span>{settingsLabel}</span>
                <kbd>{settingsShortcutHint}</kbd>
              </button>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className={`title-bar-button title-bar-settings-button${
            settingsActive ? " is-active" : ""
          }`}
          onClick={onOpenSettings}
          aria-label={settingsLabel}
          aria-pressed={settingsActive}
          title={settingsLabel}
        >
          <Settings size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
        {voiceAvailable ? (
          <span className="title-bar-control-separator" aria-hidden="true" />
        ) : null}
        {voiceAvailable ? (
          <button
            type="button"
            className="title-bar-button title-bar-voice-button"
            data-voice-state={voiceState}
            data-microphone-active={voiceMicrophoneActive}
            onClick={onToggleVoice}
            disabled={voiceDisabled}
            aria-label={voiceLabel}
            aria-pressed={voiceState === "active"}
            aria-busy={voiceState === "connecting" || undefined}
            title={voiceLabel}
          >
            {voiceState === "connecting" ? (
              <LoaderCircle size={15} strokeWidth={1.8} aria-hidden="true" />
            ) : (
              <Mic size={15} strokeWidth={1.8} aria-hidden="true" />
            )}
            {voiceState === "active" && voiceMicrophoneActive ? (
              <span className="title-bar-voice-status-dot" aria-hidden="true" />
            ) : null}
          </button>
        ) : null}
        {voiceState === "active" && onToggleVoiceApproval ? (
          <div className="voice-approval-control">
            <button
              type="button"
              className="title-bar-button voice-approval-toggle"
              aria-pressed={voiceApprovalEnabled}
              onClick={onToggleVoiceApproval}
              title={
                japanese
                  ? "この音声セッションで音声承認を有効化（実験的）"
                  : "Enable voice approval for this voice session (experimental)"
              }
            >
              {japanese ? "音声承認" : "Voice approval"}
            </button>
            {approvalVisible && voiceApproval ? (
              <section
                className="voice-approval-panel"
                aria-label={japanese ? "音声承認の確認" : "Review voice approval"}
              >
                <strong>{japanese ? "実行内容を確認してください" : "Review this operation"}</strong>
                <dl>
                  <dt>{japanese ? "コマンド" : "Command"}</dt>
                  <dd>
                    <pre>{voiceApproval.command}</pre>
                  </dd>
                  <dt>{japanese ? "作業ディレクトリ" : "Working directory"}</dt>
                  <dd>
                    <pre>{voiceApproval.cwd}</pre>
                  </dd>
                  <dt>{japanese ? "理由" : "Reason"}</dt>
                  <dd>
                    {voiceApproval.reason || (japanese ? "理由の指定なし" : "No reason provided")}
                  </dd>
                </dl>
                <p>
                  {japanese
                    ? "内容を確認し、次のフレーズを話してください。"
                    : "Review the details, then say one of these phrases."}
                </p>
                {voiceApproval.canAccept ? (
                  <p>
                    <code>
                      {japanese
                        ? `承認 ${voiceApproval.code} 確定`
                        : `approve ${voiceApproval.code} confirm`}
                    </code>
                  </p>
                ) : null}
                {voiceApproval.canDecline ? (
                  <p>
                    <code>
                      {japanese
                        ? `拒否 ${voiceApproval.code} 確定`
                        : `deny ${voiceApproval.code} confirm`}
                    </code>
                  </p>
                ) : null}
                <details>
                  <summary>{japanese ? "リクエストの詳細" : "Request details"}</summary>
                  <pre>{voiceApproval.details}</pre>
                </details>
                <p className="voice-approval-note">
                  {japanese
                    ? "実験的な機能です。ターミナルでの手動承認も引き続き使えます。"
                    : "Experimental. Manual approval in the terminal remains available."}
                </p>
              </section>
            ) : null}
          </div>
        ) : null}
        {screenSharingControl}
      </div>
      {voiceError ? (
        <div
          className="title-bar-voice-error"
          data-permission={!!permissionKind}
          role="alert"
          title={permissionKind ? undefined : voiceError}
        >
          {permissionKind ? (
            <MediaPermissionHelp kind={permissionKind} language={language} />
          ) : (
            voiceError
          )}
        </div>
      ) : null}
      <div className="title-bar-tabs" data-tauri-drag-region="">
        {tabs}
      </div>
    </header>
  );
}

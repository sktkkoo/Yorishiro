import { LoaderCircle, Mic, MicOff, PanelLeftClose, PanelLeftOpen, Settings } from "lucide-react";
import type { ReactNode } from "react";

export interface TitleBarProps {
  readonly onToggleSidebar: () => void;
  readonly onOpenSettings: () => void;
  readonly sidebarOpen: boolean;
  readonly settingsActive: boolean;
  readonly settingsLabel: string;
  readonly sidebarLabel: string;
  readonly voiceAvailable?: boolean;
  readonly voiceActive?: boolean;
  readonly voiceBusy?: boolean;
  readonly voiceLabel?: string;
  readonly voiceBillingLabel?: string;
  readonly voiceError?: string;
  readonly onToggleVoice?: () => void;
  readonly tabs?: ReactNode;
}

export default function TitleBar({
  onToggleSidebar,
  onOpenSettings,
  sidebarOpen,
  settingsActive,
  settingsLabel,
  sidebarLabel,
  voiceAvailable = false,
  voiceActive = false,
  voiceBusy = false,
  voiceLabel = "",
  voiceBillingLabel,
  voiceError,
  onToggleVoice,
  tabs,
}: TitleBarProps) {
  const SidebarIcon = sidebarOpen ? PanelLeftClose : PanelLeftOpen;

  return (
    <header className="title-bar" data-tauri-drag-region="">
      <div className="title-bar-controls">
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
          <button
            type="button"
            className={`title-bar-button title-bar-voice-button${
              voiceActive ? " is-active" : ""
            }${voiceBusy ? " is-busy" : ""}`}
            onClick={onToggleVoice}
            aria-label={voiceLabel}
            aria-pressed={voiceActive}
            title={voiceLabel}
          >
            {voiceBusy ? (
              <LoaderCircle size={15} strokeWidth={1.8} aria-hidden="true" />
            ) : voiceActive ? (
              <MicOff size={15} strokeWidth={1.8} aria-hidden="true" />
            ) : (
              <Mic size={15} strokeWidth={1.8} aria-hidden="true" />
            )}
          </button>
        ) : null}
        {voiceAvailable && voiceBillingLabel ? (
          <span className="title-bar-voice-billing" role="status" title={voiceBillingLabel}>
            {voiceBillingLabel}
          </span>
        ) : null}
      </div>
      {voiceError ? (
        <div className="title-bar-voice-error" role="status" title={voiceError}>
          {voiceError}
        </div>
      ) : null}
      <div className="title-bar-tabs" data-tauri-drag-region="">
        {tabs}
      </div>
    </header>
  );
}

import { PanelLeftClose, PanelLeftOpen, Settings } from "lucide-react";
import type { ReactNode } from "react";

export interface TitleBarProps {
  readonly onToggleSidebar: () => void;
  readonly onOpenSettings: () => void;
  readonly sidebarOpen: boolean;
  readonly settingsActive: boolean;
  readonly settingsLabel: string;
  readonly sidebarLabel: string;
  readonly tabs?: ReactNode;
}

export default function TitleBar({
  onToggleSidebar,
  onOpenSettings,
  sidebarOpen,
  settingsActive,
  settingsLabel,
  sidebarLabel,
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
      </div>
      <div className="title-bar-tabs">{tabs}</div>
    </header>
  );
}

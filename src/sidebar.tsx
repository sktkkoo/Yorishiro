import { Folder, Settings } from "lucide-react";

interface SidebarProps {
  readonly folderName: string;
  readonly onPickFolder: () => void;
  readonly onOpenSettings: () => void;
  readonly settingsLabel: string;
}

export default function Sidebar({
  folderName,
  onPickFolder,
  onOpenSettings,
  settingsLabel,
}: SidebarProps) {
  return (
    <div className="sidebar">
      <div className="sidebar-top-row">
        <button type="button" className="folder-btn" onClick={onPickFolder} title={folderName}>
          <Folder className="folder-icon" size={14} aria-hidden="true" />
          <span className="folder-name">{folderName}</span>
        </button>
        <button
          type="button"
          className="settings-btn"
          onClick={onOpenSettings}
          aria-label={settingsLabel}
          title={settingsLabel}
        >
          <Settings size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

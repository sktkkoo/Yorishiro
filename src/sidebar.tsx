import { Folder, Settings } from "lucide-react";
import { useEffect, useRef } from "react";
import { getSurfaceRegistry } from "./runtime/surface-registry";

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
  const ref = useRef<HTMLDivElement>(null);

  // NOTE: React StrictMode の effect 二重実行は cleanup→re-register の順で進み、
  // 同一 el identity なので unregister が中間で外しても直後の register が復元する。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reg = getSurfaceRegistry();
    reg.register("chrome", el);
    return () => reg.unregister("chrome", el);
  }, []);

  return (
    <div className="sidebar" ref={ref}>
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

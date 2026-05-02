import { Folder, Settings } from "lucide-react";
import { lazy, Suspense } from "react";
import type { Body } from "./core/body";
import type { SubsystemLog } from "./core/dev-log";
import { SceneRouter } from "./core/scene";
import type { ScenePackEntry } from "./runtime/scene-pack-registry/types";

const VrmViewer = lazy(() => import("./vrm-viewer"));

interface SidebarProps {
  readonly folderName: string;
  readonly onPickFolder: () => void;
  readonly vrmUrl: string | null;
  readonly onOpenSettings: () => void;
  readonly onBodyReady?: (body: Body | null) => void;
  readonly bodyDevLog?: SubsystemLog;
  /** Active scene pack の entry。null は未登録状態。 */
  readonly scene: ScenePackEntry | null;
}

export default function Sidebar({
  folderName,
  onPickFolder,
  vrmUrl,
  onOpenSettings,
  onBodyReady,
  bodyDevLog,
  scene,
}: SidebarProps) {
  const vrmContent = vrmUrl ? (
    <Suspense fallback={<div className="vrm-loading" />}>
      <VrmViewer url={vrmUrl} onBodyReady={onBodyReady} devLog={bodyDevLog} />
    </Suspense>
  ) : (
    <div className="vrm-placeholder" />
  );

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
          aria-label="設定"
          title="設定"
        >
          <Settings size={14} aria-hidden="true" />
        </button>
      </div>

      <div className="charactor-container">
        <SceneRouter entry={scene}>{vrmContent}</SceneRouter>
      </div>
    </div>
  );
}

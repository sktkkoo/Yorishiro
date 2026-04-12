import { lazy, Suspense } from "react";

const VrmViewer = lazy(() => import("./vrm-viewer"));

interface SidebarProps {
  readonly folderName: string;
  readonly onPickFolder: () => void;
  readonly vrmUrl: string | null;
  readonly onLoadVrm: () => void;
}

export default function Sidebar({ folderName, onPickFolder, vrmUrl, onLoadVrm }: SidebarProps) {
  return (
    <div className="sidebar">
      <button type="button" className="folder-btn" onClick={onPickFolder} title={folderName}>
        <span className="folder-icon">📁</span>
        <span className="folder-name">{folderName}</span>
      </button>

      <div className="charactor-container">
        {vrmUrl ? (
          <Suspense fallback={<div className="vrm-loading">読み込み中...</div>}>
            <VrmViewer url={vrmUrl} />
          </Suspense>
        ) : (
          <div className="vrm-placeholder">
            <span className="vrm-placeholder-icon">🤖</span>
            <p className="vrm-placeholder-text">VRM 未読み込み</p>
          </div>
        )}
      </div>

      <button type="button" className="avatar-btn" onClick={onLoadVrm}>
        <span className="avatar-btn-label">{vrmUrl ? "アバターを変更" : "アバターを読み込む"}</span>
      </button>
    </div>
  );
}

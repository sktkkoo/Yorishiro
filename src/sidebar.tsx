import { lazy, Suspense } from "react";
import type { Body } from "./core/body";
import type { SubsystemLog } from "./core/dev-log";
import { SceneCompositor, type SceneSpec } from "./core/scene";

const VrmViewer = lazy(() => import("./vrm-viewer"));

interface SidebarProps {
  readonly folderName: string;
  readonly onPickFolder: () => void;
  readonly vrmUrl: string | null;
  readonly onLoadVrm: () => void;
  readonly onOpenSettings: () => void;
  readonly onBodyReady?: (body: Body | null) => void;
  readonly bodyDevLog?: SubsystemLog;
  readonly scene: SceneSpec | null;
}

export default function Sidebar({
  folderName,
  onPickFolder,
  vrmUrl,
  onLoadVrm,
  onOpenSettings,
  onBodyReady,
  bodyDevLog,
  scene,
}: SidebarProps) {
  return (
    <div className="sidebar">
      <div className="sidebar-top-row">
        <button type="button" className="folder-btn" onClick={onPickFolder} title={folderName}>
          <span className="folder-icon">📁</span>
          <span className="folder-name">{folderName}</span>
        </button>
        <button
          type="button"
          className="settings-btn"
          onClick={onOpenSettings}
          aria-label="設定"
          title="設定"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>

      <div className="charactor-container">
        {scene !== null ? (
          <SceneCompositor scene={scene}>
            {vrmUrl ? (
              <Suspense fallback={<div className="vrm-loading">読み込み中...</div>}>
                <VrmViewer url={vrmUrl} onBodyReady={onBodyReady} devLog={bodyDevLog} />
              </Suspense>
            ) : (
              <div className="vrm-placeholder">
                <span className="vrm-placeholder-icon">🤖</span>
                <p className="vrm-placeholder-text">VRM 未読み込み</p>
                <button type="button" className="avatar-btn-cta" onClick={onLoadVrm}>
                  アバターを読み込む →
                </button>
              </div>
            )}
          </SceneCompositor>
        ) : vrmUrl ? (
          <Suspense fallback={<div className="vrm-loading">読み込み中...</div>}>
            <VrmViewer url={vrmUrl} onBodyReady={onBodyReady} devLog={bodyDevLog} />
          </Suspense>
        ) : (
          <div className="vrm-placeholder">
            <span className="vrm-placeholder-icon">🤖</span>
            <p className="vrm-placeholder-text">VRM 未読み込み</p>
            <button type="button" className="avatar-btn-cta" onClick={onLoadVrm}>
              アバターを読み込む →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

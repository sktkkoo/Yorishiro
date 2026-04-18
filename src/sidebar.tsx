import { lazy, Suspense } from "react";
import type { Body } from "./core/body";
import type { SubsystemLog } from "./core/dev-log";
import { SceneCompositor, type SceneSpec } from "./core/scene";
import type { EffectDispatcher } from "./core/space";

const VrmViewer = lazy(() => import("./vrm-viewer"));

interface SidebarProps {
  readonly folderName: string;
  readonly onPickFolder: () => void;
  readonly vrmUrl: string | null;
  readonly onLoadVrm: () => void;
  readonly onBodyReady?: (body: Body | null) => void;
  readonly bodyDevLog?: SubsystemLog;
  readonly effectDispatcher?: EffectDispatcher;
  readonly scene: SceneSpec;
}

export default function Sidebar({
  folderName,
  onPickFolder,
  vrmUrl,
  onLoadVrm,
  onBodyReady,
  bodyDevLog,
  effectDispatcher,
  scene,
}: SidebarProps) {
  return (
    <div className="sidebar">
      <button type="button" className="folder-btn" onClick={onPickFolder} title={folderName}>
        <span className="folder-icon">📁</span>
        <span className="folder-name">{folderName}</span>
      </button>

      <div className="charactor-container">
        <SceneCompositor scene={scene}>
          {vrmUrl ? (
            <Suspense fallback={<div className="vrm-loading">読み込み中...</div>}>
              <VrmViewer
                url={vrmUrl}
                onBodyReady={onBodyReady}
                devLog={bodyDevLog}
                effectDispatcher={effectDispatcher}
              />
            </Suspense>
          ) : (
            <div className="vrm-placeholder">
              <span className="vrm-placeholder-icon">🤖</span>
              <p className="vrm-placeholder-text">VRM 未読み込み</p>
            </div>
          )}
        </SceneCompositor>
      </div>

      <button type="button" className="avatar-btn" onClick={onLoadVrm}>
        <span className="avatar-btn-label">{vrmUrl ? "アバターを変更" : "アバターを読み込む"}</span>
      </button>
    </div>
  );
}

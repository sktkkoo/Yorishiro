interface SidebarProps {
  readonly folderName: string;
  readonly onPickFolder: () => void;
  readonly vrmName: string | null;
  readonly onLoadVrm: () => void;
}

export default function Sidebar({ folderName, onPickFolder, vrmName, onLoadVrm }: SidebarProps) {
  return (
    <div className="sidebar">
      <button type="button" className="folder-btn" onClick={onPickFolder} title={folderName}>
        <span className="folder-icon">📁</span>
        <span className="folder-name">{folderName}</span>
      </button>

      <div className="charactor-container">
        {vrmName ? (
          <div className="vrm-loaded">
            <span className="vrm-loaded-icon">🧍</span>
            <p className="vrm-loaded-name">{vrmName}</p>
          </div>
        ) : (
          <div className="vrm-placeholder">
            <span className="vrm-placeholder-icon">🤖</span>
            <p className="vrm-placeholder-text">VRM 未読み込み</p>
          </div>
        )}
      </div>

      <button type="button" className="avatar-btn" onClick={onLoadVrm}>
        <span className="avatar-btn-label">
          {vrmName ? "アバターを変更" : "アバターを読み込む"}
        </span>
      </button>
    </div>
  );
}

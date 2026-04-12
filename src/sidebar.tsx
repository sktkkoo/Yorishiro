interface SidebarProps {
  readonly folderName: string;
  readonly onPickFolder: () => void;
}

export default function Sidebar({ folderName, onPickFolder }: SidebarProps) {
  return (
    <div className="sidebar">
      <button type="button" className="folder-btn" onClick={onPickFolder} title={folderName}>
        <span className="folder-icon">📁</span>
        <span className="folder-name">{folderName}</span>
      </button>

      <div className="charactor-container">
        <div className="vrm-placeholder">
          <span className="vrm-placeholder-icon">🤖</span>
          <p className="vrm-placeholder-text">VRM 未読み込み</p>
        </div>
      </div>
    </div>
  );
}

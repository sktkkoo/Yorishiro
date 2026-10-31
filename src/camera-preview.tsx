import { ExternalLink, PanelBottom, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import "./camera-preview.css";
import type { SharingDeliveryMode } from "./runtime/sharing-delivery";

export interface CameraPreviewProps {
  readonly deliveryMode?: SharingDeliveryMode;
  readonly sourceKind?: "camera" | "screen";
  readonly stream?: MediaStream;
  readonly imageDataUrl?: string;
  readonly detached?: boolean;
  readonly opening?: boolean;
  readonly error?: string;
  readonly onDetach?: () => void;
  readonly onAttach?: () => void;
  readonly lastCapturedAt?: number;
  readonly lastSharedAt?: number;
  readonly language?: string;
  readonly onStop: () => void;
}

/** Local-only monitor of the already-owned camera. Unmount never stops the capture owner's tracks. */
export function CameraPreview({
  deliveryMode = "context",
  sourceKind = "camera",
  stream,
  imageDataUrl,
  detached = false,
  opening = false,
  error,
  onDetach,
  onAttach,
  lastCapturedAt,
  lastSharedAt,
  language = "en",
  onStop,
}: CameraPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const japanese = language.startsWith("ja");
  const ready = Boolean(lastSharedAt && lastCapturedAt && lastSharedAt >= lastCapturedAt);
  const captureStatus =
    deliveryMode === "on-demand"
      ? ready
        ? japanese
          ? "共有準備完了"
          : "Ready to share"
        : japanese
          ? "撮影済み・準備中"
          : "Captured · preparing"
      : ready
        ? japanese
          ? "AI送信済み"
          : "Sent to AI"
        : japanese
          ? "撮影済み・送信待ち"
          : "Captured · waiting";
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;
    let disposed = false;
    video.srcObject = stream;
    setPlaybackBlocked(false);
    void video.play().catch(() => {
      if (!disposed) setPlaybackBlocked(true);
    });
    return () => {
      disposed = true;
      video.pause();
      video.srcObject = null;
    };
  }, [stream]);

  return (
    <section
      className={`camera-preview${detached ? " camera-preview--detached" : ""}${sourceKind === "screen" ? " camera-preview--screen" : ""}${imageDataUrl ? " camera-preview--capture-grid" : ""}${imageDataUrl && ready ? " camera-preview--sent" : ""}`}
      data-screen-preview-inline={sourceKind === "screen" && !detached ? "" : undefined}
      data-no-window-drag
      aria-label={
        sourceKind === "screen"
          ? japanese
            ? "画面共有プレビュー"
            : "Screen sharing preview"
          : japanese
            ? "カメラプレビュー"
            : "Camera preview"
      }
    >
      <header data-tauri-drag-region={detached ? "" : undefined}>
        {sourceKind === "screen" ? (
          <span className="camera-preview-capture-status camera-preview-capture-status--header">
            {captureStatus}
          </span>
        ) : null}
        {onDetach || onAttach ? (
          <button
            type="button"
            className="camera-preview-window-button"
            disabled={opening}
            onClick={detached ? onAttach : onDetach}
            aria-label={
              detached
                ? japanese
                  ? "ヨリシロ内に戻す"
                  : "Return to Yorishiro"
                : japanese
                  ? "別ウィンドウで開く"
                  : "Open in separate window"
            }
            title={
              detached
                ? japanese
                  ? "ヨリシロ内に戻す"
                  : "Return to Yorishiro"
                : japanese
                  ? "別ウィンドウで開く"
                  : "Open in separate window"
            }
          >
            {detached ? (
              <PanelBottom size={13} aria-hidden="true" />
            ) : (
              <ExternalLink size={13} aria-hidden="true" />
            )}
          </button>
        ) : null}
        <button
          type="button"
          className="camera-preview-stop"
          onClick={onStop}
          aria-label={
            sourceKind === "screen"
              ? japanese
                ? "画面共有を停止"
                : "Stop screen sharing"
              : japanese
                ? "カメラ共有を停止"
                : "Stop camera sharing"
          }
          title={
            sourceKind === "screen"
              ? japanese
                ? "画面共有を停止"
                : "Stop screen sharing"
              : japanese
                ? "カメラ共有を停止"
                : "Stop camera sharing"
          }
        >
          <Square size={10} fill="currentColor" aria-hidden="true" />
          <span>{japanese ? "停止" : "Stop"}</span>
        </button>
      </header>
      <div className="camera-preview-image">
        {/* The stream is explicitly video-only; there is no audio to caption. */}
        {stream ? (
          <video
            ref={videoRef}
            muted
            playsInline
            aria-label={japanese ? "共有中のカメラ映像" : "Shared camera view"}
          />
        ) : imageDataUrl ? (
          <img
            src={imageDataUrl}
            alt={
              sourceKind === "screen"
                ? deliveryMode === "on-demand"
                  ? japanese
                    ? "直近に取得した画面"
                    : "Latest captured screen"
                  : japanese
                    ? "直近に共有した画面"
                    : "Last shared screen"
                : japanese
                  ? "共有中のカメラ映像"
                  : "Shared camera view"
            }
            draggable={false}
            data-tauri-drag-region={detached ? "" : undefined}
          />
        ) : null}
        {sourceKind === "screen" ? (
          <span
            className={`camera-preview-capture-cue camera-preview-capture-cue--stable ${ready ? "camera-preview-capture-cue--sent" : "camera-preview-capture-cue--queued"}`}
            aria-hidden="true"
          />
        ) : lastCapturedAt !== undefined && Date.now() - lastCapturedAt < 1500 ? (
          <span key={lastCapturedAt} className="camera-preview-capture-cue" aria-hidden="true">
            <span className="camera-preview-flash" />
          </span>
        ) : null}
        {playbackBlocked ? (
          <button
            className="camera-preview-resume"
            type="button"
            onClick={() => {
              void videoRef.current
                ?.play()
                .then(() => setPlaybackBlocked(false))
                .catch(() => {});
            }}
          >
            {japanese ? "プレビューを再生" : "Play preview"}
          </button>
        ) : null}
      </div>
      {error ? (
        <footer>
          <span role="alert">{error}</span>
        </footer>
      ) : null}
    </section>
  );
}

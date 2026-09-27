import { useEffect, useRef, useState } from "react";
import { CameraPreview } from "./camera-preview";
import {
  type CameraPreviewFrame,
  listenCameraPreview,
  readCameraPreview,
  requestCameraPreviewAction,
} from "./runtime/camera-preview-window";

/** Local preview consumer only. The main window retains camera and conversation ownership. */
export default function AuxiliaryCameraPreview() {
  const [frame, setFrame] = useState<CameraPreviewFrame | null>(null);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const japanese = (frame?.language ?? navigator.language).startsWith("ja");
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let eventRevision = 0;
    const receive = (next: CameraPreviewFrame | null) => {
      if (disposed) return;
      setFrame((previous) => {
        if (!next) return null;
        return previous && (previous.sequence ?? 0) > (next.sequence ?? 0) ? previous : next;
      });
    };
    void listenCameraPreview((next) => {
      eventRevision += 1;
      receive(next);
    })
      .then(async (cleanup) => {
        if (disposed) {
          cleanup();
          return;
        }
        unlisten = cleanup;
        const beforeRead = eventRevision;
        const snapshot = await readCameraPreview();
        // A late snapshot (including null) must not replace a newer live event.
        if (eventRevision === beforeRead) receive(snapshot);
      })
      .catch(() => {
        if (!disposed) setError("Could not connect to the camera preview.");
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const request = async (action: "stop" | "attach") => {
    if (!frame || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(undefined);
    try {
      await requestCameraPreviewAction(frame.leaseId, action);
    } catch {
      setError(
        japanese
          ? "操作できませんでした。もう一度お試しください。"
          : "Could not complete the action. Try again.",
      );
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <main className="camera-preview-window">
      {frame ? (
        <CameraPreview
          detached
          imageDataUrl={frame.imageDataUrl}
          lastCapturedAt={frame.lastCapturedAt}
          lastSharedAt={frame.lastSharedAt}
          language={frame.language}
          deliveryMode={frame.deliveryMode}
          opening={pending}
          error={error}
          onAttach={() => void request("attach")}
          onStop={() => void request("stop")}
        />
      ) : (
        <p role="status">
          {error ?? (japanese ? "カメラ映像を待っています…" : "Waiting for camera preview…")}
        </p>
      )}
    </main>
  );
}

import { useEffect, useRef, useState } from "react";
import { CameraPreview } from "./camera-preview";
import {
  listenScreenPreview,
  readScreenPreview,
  requestScreenPreviewAction,
  type ScreenPreviewFrame,
  showScreenPreview,
} from "./runtime/screen-preview-window";

/** Local preview consumer only. The main window retains camera and conversation ownership. */
export default function AuxiliaryScreenPreview() {
  const [frame, setFrame] = useState<ScreenPreviewFrame | null>(null);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const shownLease = useRef<string | undefined>(undefined);
  const japanese = (frame?.language ?? navigator.language).startsWith("ja");
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let eventRevision = 0;
    const receive = (next: ScreenPreviewFrame | null) => {
      if (disposed) return;
      setFrame((previous) => {
        if (!next) return null;
        return previous && (previous.sequence ?? 0) > (next.sequence ?? 0) ? previous : next;
      });
    };
    void listenScreenPreview((next) => {
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
        const snapshot = await readScreenPreview();
        // A late snapshot (including null) must not replace a newer live event.
        if (eventRevision === beforeRead) receive(snapshot);
      })
      .catch(() => {
        if (!disposed) setError("Could not connect to the screen preview.");
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
      await requestScreenPreviewAction(frame.leaseId, action);
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
    <main
      className="camera-preview-window"
      onLoadCapture={(event) => {
        if (
          !(event.target instanceof HTMLImageElement) ||
          !frame ||
          shownLease.current === frame.leaseId
        )
          return;
        const leaseId = frame.leaseId;
        shownLease.current = leaseId;
        void showScreenPreview(leaseId).catch(() => {
          shownLease.current = undefined;
        });
      }}
    >
      {frame ? (
        <CameraPreview
          detached
          sourceKind="screen"
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
      ) : null}
    </main>
  );
}

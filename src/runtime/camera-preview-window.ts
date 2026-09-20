import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type PreviewTransport as HostTransport,
  PreviewHost,
  type PreviewStatus,
} from "./preview-host";

import type { SharingDeliveryMode } from "./sharing-delivery";

export const PREVIEW_WINDOW_LABEL = "auxiliary-camera-preview";
export const PREVIEW_STATE_EVENT = "camera-preview-state";
const PREVIEW_ACTION_EVENT = "camera-preview-action";
export interface CameraPreviewFrame {
  deliveryMode?: SharingDeliveryMode;
  leaseId: string;
  imageDataUrl: string;
  lastCapturedAt?: number;
  lastSharedAt?: number;
  language: string;
  sequence?: number;
}
interface PreviewAction {
  leaseId: string;
  action: "stop" | "attach";
}
export function listenCameraPreview(
  callback: (frame: CameraPreviewFrame | null) => void,
): Promise<() => void> {
  return getCurrentWindow().listen<CameraPreviewFrame | null>(PREVIEW_STATE_EVENT, (event) =>
    callback(event.payload),
  );
}
export function readCameraPreview(): Promise<CameraPreviewFrame | null> {
  return invoke("camera_preview_snapshot");
}
export function requestCameraPreviewAction(
  leaseId: string,
  action: "stop" | "attach",
): Promise<void> {
  return invoke("camera_preview_request_action", { leaseId, action });
}
export interface CameraPreviewModel {
  deliveryMode?: SharingDeliveryMode;
  visible?: boolean;
  initiallyDetached?: boolean;
  stream: MediaStream | null;
  lastCapturedAt?: number;
  lastSharedAt?: number;
  language: string;
  onStop: () => void;
}
type PreviewTransport = HostTransport<CameraPreviewFrame>;
const nativeTransport: PreviewTransport = {
  begin: () => invoke("camera_preview_begin"),
  open: (leaseId) => invoke("camera_preview_open", { leaseId }),
  revoke: (leaseId) => invoke("camera_preview_revoke", { leaseId }),
  publish: (frame) => invoke("camera_preview_publish", { frame }),
  listen: (callback) =>
    getCurrentWindow().listen<PreviewAction>(PREVIEW_ACTION_EVENT, (event) =>
      callback(event.payload),
    ),
};

/** Only projects the existing stream; does not acquire, stop, or share camera tracks. */
export function startCameraPreviewRelay(
  stream: MediaStream,
  frame: () => Omit<CameraPreviewFrame, "imageDataUrl">,
  publish: (frame: CameraPreviewFrame) => Promise<void>,
  fail: (error: unknown) => void,
): () => void {
  const video = document.createElement("video");
  const canvas = document.createElement("canvas");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  let stopped = false;
  let inFlight = false;
  const readyDeadline = setTimeout(() => {
    if (!stopped && video.readyState < 2)
      fail(new Error("The camera preview did not become ready."));
  }, 5000);
  const context = canvas.getContext("2d");
  const timer = setInterval(() => {
    if (stopped || inFlight || video.readyState < 2 || !video.videoWidth || !video.videoHeight)
      return;
    if (!context) {
      fail(new Error("Camera preview is unavailable."));
      return;
    }
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageDataUrl = canvas.toDataURL("image/jpeg", 0.65);
      if (!imageDataUrl.startsWith("data:image/jpeg;base64,") || imageDataUrl.length > 349550) {
        throw new Error("Camera preview image is unavailable.");
      }
      inFlight = true;
      void publish({ ...frame(), imageDataUrl })
        .catch((error: unknown) => {
          if (!stopped) fail(error);
        })
        .finally(() => {
          inFlight = false;
        });
    } catch (error) {
      if (!stopped) fail(error);
    }
  }, 125);
  void video.play().catch((error: unknown) => {
    if (!stopped) fail(error);
  });
  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(readyDeadline);
    video.pause();
    video.srcObject = null;
    canvas.width = 0;
    canvas.height = 0;
  };
}

// Serialize owners across React remounts, independently for each native preview window.
const lifecycle = { pending: Promise.resolve() as Promise<void> };
export class CameraPreviewHost extends PreviewHost<
  CameraPreviewModel,
  MediaStream,
  CameraPreviewFrame
> {
  constructor(
    model: CameraPreviewModel,
    changed: (state: PreviewStatus) => void,
    transport: PreviewTransport = nativeTransport,
    relay = startCameraPreviewRelay,
  ) {
    super(
      model,
      changed,
      transport,
      {
        source: (model) => model.stream,
        ready: () => true,
        relay: (source, model, leaseId, publish, fail) =>
          relay(
            source,
            () => ({
              leaseId,
              deliveryMode: model().deliveryMode ?? "context",
              language: model().language.startsWith("ja") ? "ja" : "en",
              lastCapturedAt: finiteTimestamp(model().lastCapturedAt),
              lastSharedAt: finiteTimestamp(model().lastSharedAt),
            }),
            publish,
            fail,
          ),
      },
      lifecycle,
    );
  }
}
function finiteTimestamp(value: number | undefined): number | undefined {
  return value !== undefined &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : undefined;
}
export function useCameraPreviewWindow(model: CameraPreviewModel) {
  const latest = useRef(model);
  latest.current = model;
  const host = useRef<CameraPreviewHost | null>(null);
  const [status, setStatus] = useState<PreviewStatus>({ detached: false, opening: false });
  useEffect(() => {
    const owner = new CameraPreviewHost(latest.current, setStatus);
    host.current = owner;
    return () => {
      if (host.current === owner) host.current = null;
      owner.dispose();
    };
  }, []);
  // The action handler consults this ref-backed model before accepting native actions.
  useEffect(() => {
    host.current?.update(model);
  }, [model]);
  const detach = useCallback(async () => {
    await host.current?.detach();
  }, []);
  const attach = useCallback(async () => {
    await host.current?.attach();
  }, []);
  return {
    ...status,
    inlineVisible: host.current?.isInline(model) ?? !model.initiallyDetached,
    detach,
    attach,
  };
}

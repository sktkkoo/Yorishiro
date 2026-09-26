import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type PreviewTransport as HostTransport,
  PreviewHost,
  type PreviewStatus,
} from "./preview-host";

import type { SharingDeliveryMode } from "./sharing-delivery";

export const PREVIEW_WINDOW_LABEL = "auxiliary-screen-preview";
export const PREVIEW_STATE_EVENT = "screen-preview-state";
const PREVIEW_ACTION_EVENT = "screen-preview-action";
export interface ScreenPreviewFrame {
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
export function listenScreenPreview(
  callback: (frame: ScreenPreviewFrame | null) => void,
): Promise<() => void> {
  return getCurrentWindow().listen<ScreenPreviewFrame | null>(PREVIEW_STATE_EVENT, (event) =>
    callback(event.payload),
  );
}
export function readScreenPreview(): Promise<ScreenPreviewFrame | null> {
  return invoke("screen_preview_snapshot");
}
export function showScreenPreview(leaseId: string): Promise<void> {
  return invoke("screen_preview_ready", { leaseId });
}
export function requestScreenPreviewAction(
  leaseId: string,
  action: "stop" | "attach",
): Promise<void> {
  return invoke("screen_preview_request_action", { leaseId, action });
}
export interface ScreenPreviewModel {
  deliveryMode?: SharingDeliveryMode;
  visible?: boolean;
  initiallyDetached?: boolean;
  sourceKey: string | null;
  frame: { imageDataUrl: string; lastCapturedAt?: number; lastSharedAt?: number } | null;
  language: string;
  onStop: () => void;
}
type PreviewTransport = HostTransport<ScreenPreviewFrame>;
const nativeTransport: PreviewTransport = {
  begin: () => invoke("screen_preview_begin"),
  open: (leaseId) => invoke("screen_preview_open", { leaseId }),
  revoke: (leaseId) => invoke("screen_preview_revoke", { leaseId }),
  publish: (frame) => invoke("screen_preview_publish", { frame }),
  listen: (callback) =>
    getCurrentWindow().listen<PreviewAction>(PREVIEW_ACTION_EVENT, (event) =>
      callback(event.payload),
    ),
};

/** Relays only the latest successfully shared still; never captures or sends context. */
export function startScreenPreviewRelay(
  _sourceKey: string,
  frame: () => ScreenPreviewFrame | null,
  publish: (frame: ScreenPreviewFrame) => Promise<void>,
  fail: (error: unknown) => void,
): () => void {
  let stopped = false;
  let inFlight = false;
  let lastImage: string | undefined;
  let lastSharedAt: number | undefined;
  let lastLanguage: string | undefined;
  let lastDeliveryMode: SharingDeliveryMode | undefined;
  const tick = () => {
    if (stopped || inFlight) return;
    const next = frame();
    if (
      !next ||
      (next.imageDataUrl === lastImage &&
        next.lastSharedAt === lastSharedAt &&
        next.language === lastLanguage &&
        next.deliveryMode === lastDeliveryMode)
    )
      return;
    inFlight = true;
    void publish(next)
      .then(() => {
        lastImage = next.imageDataUrl;
        lastSharedAt = next.lastSharedAt;
        lastLanguage = next.language;
        lastDeliveryMode = next.deliveryMode;
      })
      .catch((error: unknown) => {
        if (!stopped) fail(error);
      })
      .finally(() => {
        inFlight = false;
      });
  };
  const timer = setInterval(tick, 125);
  tick();
  return () => {
    stopped = true;
    clearInterval(timer);
    lastImage = undefined;
  };
}

// Serialize owners across React remounts, independently for each native preview window.
const lifecycle = { pending: Promise.resolve() as Promise<void> };
export class ScreenPreviewHost extends PreviewHost<ScreenPreviewModel, string, ScreenPreviewFrame> {
  constructor(
    model: ScreenPreviewModel,
    changed: (state: PreviewStatus) => void,
    transport: PreviewTransport = nativeTransport,
    relay = startScreenPreviewRelay,
  ) {
    super(
      model,
      changed,
      transport,
      {
        source: (model) => model.sourceKey,
        ready: (model) => model.frame !== null,
        relay: (source, model, leaseId, publish, fail) =>
          relay(
            source,
            () => {
              const current = model();
              return current.frame
                ? {
                    ...current.frame,
                    leaseId,
                    deliveryMode: current.deliveryMode ?? "context",
                    language: current.language.startsWith("ja") ? "ja" : "en",
                  }
                : null;
            },
            publish,
            fail,
          ),
      },
      lifecycle,
    );
  }
}
export function useScreenPreviewWindow(model: ScreenPreviewModel) {
  const latest = useRef(model);
  latest.current = model;
  const host = useRef<ScreenPreviewHost | null>(null);
  const [status, setStatus] = useState<PreviewStatus>({ detached: false, opening: false });
  useEffect(() => {
    const owner = new ScreenPreviewHost(latest.current, setStatus);
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

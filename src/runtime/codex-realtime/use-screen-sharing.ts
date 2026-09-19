import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ScreenCaptureRegion,
  type ScreenCaptureSelection,
  type ScreenCaptureSource,
  type ScreenSourceKind,
  screenAnnotationBegin,
  screenAnnotationClear,
  screenAnnotationDocument,
  screenAnnotationEnd,
  screenCaptureFrame,
  screenCaptureListSources,
  screenCaptureRegionFrameClose,
  screenCaptureRegionFrameOpen,
  screenCaptureRequestPermission,
  screenCaptureSelectRegion,
} from "../../bindings/tauri-commands";
import { MAX_SHARING_INTERVAL_SECONDS, MIN_SHARING_INTERVAL_SECONDS } from "../sharing-interval";
import {
  type CameraCapture,
  type CameraSource,
  listCameraSources,
  openCamera,
} from "./camera-capture";
import { buildContactSheet, type ContactSheetSample } from "./contact-sheet";
import type { ScreenObservationFrame, ScreenObservationResult } from "./screen-observation";

export type SharingSourceKind = "screen" | "camera";

interface Options {
  screenAvailable?: boolean;
  available: boolean;
  /** Changes on main-agent/thread replacement; voice reconnection keeps this lease. */
  ownerKey: string;
  share: (frame: ScreenObservationFrame, signal: AbortSignal) => Promise<ScreenObservationResult>;
  /** Durations only; never receives pixels, labels, thread IDs, or lease tokens. */
  onTiming?: (timing: ScreenSharingTiming) => void;
}

export interface ScreenSharingTiming {
  readonly reason: "periodic" | "speech";
  readonly captureMs: number;
  readonly contextMs: number;
  readonly totalMs: number;
  readonly outcome: "shared" | "unchanged" | "busy" | "cancelled" | "failed";
}

interface SharingLease {
  readonly shareId: string;
  readonly documentId?: Promise<string>;
  readonly sourceKind: SharingSourceKind;
  camera?: CameraCapture;
  sourceId: number;
  selection?: ScreenCaptureSelection;
  /** Native frame owner survives capture-lease replacement. */
  readonly frameId?: string;
  readonly ownerKey: string;
  readonly controller: AbortController;
  ready: boolean;
  adjustingRegion?: boolean;
}

interface RegionFrameEvent {
  readonly shareId: string;
  readonly sourceId: number;
  readonly region?: ScreenCaptureRegion;
}

function validRegion(region: ScreenCaptureRegion): boolean {
  return (
    [
      region.x,
      region.y,
      region.width,
      region.height,
      region.displayWidth,
      region.displayHeight,
    ].every(Number.isFinite) &&
    region.x >= 0 &&
    region.y >= 0 &&
    region.width > 0 &&
    region.height > 0 &&
    region.x + region.width <= region.displayWidth &&
    region.y + region.height <= region.displayHeight
  );
}

// A cancelled native begin may still complete. Serialize begins across hook
// lifetimes, including React remounts, so it cannot replace a newer sharing lease.
let annotationBeginQueue: Promise<void> = Promise.resolve();
// Native owns one picker. Stop invalidates its result but cannot dismiss the
// system interaction; a later lease must wait until that picker settles.
let regionPickerQueue: Promise<void> = Promise.resolve();
const DEFAULT_CONTACT_SHEET_FRAME_COUNT = 16;

import { CONTACT_SHEET_FRAME_COUNTS } from "../contact-sheet-settings";

// Native rotates this epoch when the main WebView reloads. One lookup per JS
// document prevents a Start waiting on permission from borrowing a new epoch.
let annotationDocument: Promise<string> | null = null;

export function getAnnotationDocument(): Promise<string> {
  if (annotationDocument) return annotationDocument;
  const pending = Promise.resolve()
    .then(() => screenAnnotationDocument())
    .catch((failure) => {
      if (annotationDocument === pending) annotationDocument = null;
      throw failure;
    });
  annotationDocument = pending;
  return pending;
}

function normalizeIntervalSeconds(value: number): number {
  return Number.isFinite(value)
    ? Math.max(
        MIN_SHARING_INTERVAL_SECONDS,
        Math.min(MAX_SHARING_INTERVAL_SECONDS, Math.round(value)),
      )
    : 30;
}

/** Host-owned opt-in sampling; no queued frames, no capture after a stale permission grant. */
export function useScreenSharing({
  available: baseAvailable,
  screenAvailable = true,
  ownerKey,
  share,
  onTiming,
}: Options) {
  const [sourceKind, setSourceKindState] = useState<SharingSourceKind>("screen");
  const available = baseAvailable && (sourceKind === "camera" || screenAvailable);
  const [sources, setSources] = useState<(ScreenCaptureSource | CameraSource)[]>([]);
  const sourceRefresh = useRef(0);
  const selectionAttempt = useRef(0);
  const [screenSourceKind, setScreenSourceKindState] = useState<ScreenSourceKind>("display");
  const [region, setRegion] = useState<ScreenCaptureRegion | null>(null);
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [intervalValue, setIntervalSeconds] = useState(30);
  const [contactSheetFrameCount, setContactSheetFrameCount] = useState(
    DEFAULT_CONTACT_SHEET_FRAME_COUNT,
  );
  // HMR can retain a value selected before the periodic lower bound changed.
  const intervalSeconds = normalizeIntervalSeconds(intervalValue);
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adjustingRegion, setAdjustingRegion] = useState(false);
  const regionEventsReady = useRef<Promise<void>>(Promise.resolve());
  const [error, setError] = useState<string>();
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [screenPreviewFrame, setScreenPreviewFrame] = useState<{
    imageDataUrl: string;
    lastCapturedAt: number;
    lastSharedAt: number;
  } | null>(null);
  const [screenShareKey, setScreenShareKey] = useState<string | null>(null);
  const [screenPreviewKey, setScreenPreviewKey] = useState<string | null>(null);
  const [lastCapturedAt, setLastCapturedAt] = useState<number>();
  const [lastObservedAt, setLastObservedAt] = useState<number>();
  const owner = useRef<SharingLease | null>(null);
  const inFlight = useRef<{ lease: SharingLease; promise: Promise<void> } | null>(null);
  const lastImage = useRef<{ dataUrl: string; frameId: string } | null>(null);
  const contactSheetSamples = useRef<ContactSheetSample[]>([]);
  const lastCaptureStartedAt = useRef<number | null>(null);
  const latest = useRef({
    screenSelectionSupported: false,
    available,
    ownerKey,
    share,
    onTiming,
    intervalSeconds,
    contactSheetFrameCount,
    sourceKind,
    screenSourceKind,
    sourceId,
    region,
  });
  latest.current = {
    ...latest.current,
    available,
    ownerKey,
    share,
    onTiming,
    intervalSeconds,
    contactSheetFrameCount,
    sourceKind,
    screenSourceKind,
    sourceId,
    region,
  };

  const stop = useCallback(() => {
    ++selectionAttempt.current;
    const lease = owner.current;
    lease?.controller.abort();
    owner.current = null;
    lastImage.current = null;
    contactSheetSamples.current = [];
    lastCaptureStartedAt.current = null;
    setActive(false);
    setBusy(false);
    setAdjustingRegion(false);
    setCameraStream(null);
    setScreenPreviewFrame(null);
    setScreenShareKey(null);
    setScreenPreviewKey(null);
    setLastCapturedAt(undefined);
    lease?.camera?.close();
    if (lease?.frameId) void screenCaptureRegionFrameClose(lease.frameId).catch(() => {});
    if (lease?.sourceKind === "screen") {
      // End is token scoped. A delayed reply cannot revoke a subsequent Start.
      void screenAnnotationEnd(lease.shareId).catch(() => {
        if (owner.current === null && latest.current.ownerKey === lease.ownerKey) {
          setError("Could not clear the screen markers.");
        }
      });
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Changing either owner or availability ends the sharing lease.
  useEffect(() => {
    stop();
    setLastObservedAt(undefined);
    return stop;
  }, [ownerKey, available, stop]);

  const refreshSources = useCallback(
    async (kind = latest.current.sourceKind, requestPermission = false) => {
      const attempt = ++sourceRefresh.current;
      const key = latest.current.ownerKey;
      try {
        const screenKind = latest.current.screenSourceKind;
        if (kind === "screen" && screenKind === "window" && requestPermission) {
          const granted = await screenCaptureRequestPermission();
          if (latest.current.ownerKey !== key || attempt !== sourceRefresh.current) return;
          if (!granted)
            throw new Error(
              "Screen Recording permission is required. Allow Yorishiro in System Settings → Privacy & Security → Screen Recording, then retry.",
            );
        }
        const listed =
          kind === "camera"
            ? await listCameraSources()
            : await screenCaptureListSources(screenKind === "window" ? "window" : "display");
        if (latest.current.ownerKey !== key || attempt !== sourceRefresh.current) return;
        if (
          kind === "screen" &&
          listed.some(
            (source) => "kind" in source && (source.kind === "display" || source.kind === "window"),
          )
        ) {
          latest.current.screenSelectionSupported = true;
        }
        // Older native backends ignore the kind argument and return displays.
        // Never offer those as windows, even when their numeric IDs overlap.
        const next =
          kind === "screen" && screenKind === "window"
            ? listed.filter((source) => "kind" in source && source.kind === "window")
            : listed;
        const sourceLost =
          owner.current !== null && !next.some((source) => source.id === owner.current?.sourceId);
        if (sourceLost) stop();
        setSources(next);
        const nextId = next.some((source) => source.id === latest.current.sourceId)
          ? latest.current.sourceId
          : (next[0]?.id ?? null);
        if (nextId !== latest.current.sourceId) {
          ++selectionAttempt.current;
          setRegion(null);
          latest.current = { ...latest.current, region: null };
        }
        setSourceId(nextId);
        latest.current = { ...latest.current, sourceId: nextId };
        setError(
          sourceLost
            ? kind === "camera"
              ? "The shared camera is no longer available. Select a camera and start sharing again."
              : "The shared screen source is no longer available. Select a source and start sharing again."
            : undefined,
        );
      } catch (failure) {
        if (latest.current.ownerKey === key && attempt === sourceRefresh.current)
          setError(String(failure));
      }
    },
    [stop],
  );

  useEffect(() => {
    if (sourceKind !== "camera" || !navigator.mediaDevices?.addEventListener) return;
    const changed = () => void refreshSources("camera");
    navigator.mediaDevices.addEventListener("devicechange", changed);
    return () => navigator.mediaDevices.removeEventListener("devicechange", changed);
  }, [sourceKind, refreshSources]);

  const start = useCallback(async () => {
    const current = latest.current;
    const isRegion = current.sourceKind === "screen" && current.screenSourceKind === "region";
    if (!current.available || (!isRegion && current.sourceId === null) || owner.current) return;
    if (
      current.sourceKind === "screen" &&
      current.screenSourceKind !== "display" &&
      !current.screenSelectionSupported
    )
      return;
    const shareId = crypto.randomUUID();
    const lease: SharingLease = {
      shareId,
      frameId:
        current.sourceKind === "screen" && current.screenSourceKind === "region"
          ? shareId
          : undefined,
      sourceKind: current.sourceKind,
      documentId: current.sourceKind === "screen" ? getAnnotationDocument() : undefined,
      sourceId: current.sourceId ?? 0,
      selection:
        current.screenSourceKind === "region"
          ? undefined
          : { kind: current.screenSourceKind === "window" ? "window" : "display" },
      ownerKey: latest.current.ownerKey,
      controller: new AbortController(),
      ready: false,
    };
    owner.current = lease;
    const isCurrent = () =>
      !lease.controller.signal.aborted &&
      owner.current === lease &&
      latest.current.ownerKey === lease.ownerKey &&
      latest.current.available;
    setError(undefined);
    setBusy(true);
    setLastObservedAt(undefined);
    try {
      if (lease.sourceKind === "camera") {
        const source = sources.find((source) => source.id === lease.sourceId);
        const camera = await openCamera(
          source && "deviceId" in source ? source.deviceId : undefined,
          lease.controller.signal,
          () => {
            if (!isCurrent()) return;
            stop();
            setError("The camera disconnected. Select a camera and start sharing again.");
          },
        );
        if (!isCurrent()) {
          camera.close();
          return;
        }
        lease.camera = camera;
        setCameraStream(camera.stream);
        lease.ready = true;
        setActive(true);
        return;
      }
      const documentId = await lease.documentId;
      if (!documentId) return;
      if (!isCurrent()) return;
      const granted = await screenCaptureRequestPermission();
      if (!isCurrent()) return;
      if (!granted)
        throw new Error(
          "Screen Recording permission is required. Allow Yorishiro in System Settings → Privacy & Security → Screen Recording, then retry.",
        );
      if (lease.frameId) {
        await regionEventsReady.current;
        if (!isCurrent()) return;
        // Never capture a default rectangle: Start asks the user to draw the
        // first region, and cancellation leaves sharing stopped.
        const picking = regionPickerQueue.then(() =>
          isCurrent() ? screenCaptureSelectRegion() : null,
        );
        regionPickerQueue = picking.then(
          () => {},
          () => {},
        );
        const selected = await picking;
        if (!isCurrent()) return;
        if (!selected) {
          stop();
          return;
        }
        if (!validRegion(selected.region))
          throw new Error("The selected screen region is invalid.");
        lease.sourceId = selected.sourceId;
        lease.selection = { kind: "region", region: selected.region };
        setSourceId(selected.sourceId);
        setRegion(selected.region);
        latest.current = {
          ...latest.current,
          sourceId: selected.sourceId,
          region: selected.region,
        };
        try {
          await screenCaptureRegionFrameOpen(lease.frameId, lease.sourceId, selected.region);
        } finally {
          if (!isCurrent()) await screenCaptureRegionFrameClose(lease.frameId);
        }
        if (!isCurrent()) return;
      }
      const beginning = annotationBeginQueue.then(async () => {
        if (!isCurrent()) return;
        try {
          if (lease.selection?.kind === "display") {
            await screenAnnotationBegin(lease.shareId, lease.sourceId, documentId);
          } else {
            await screenAnnotationBegin(lease.shareId, lease.sourceId, documentId, lease.selection);
          }
        } finally {
          // Stop may have reached native before this in-flight begin. Revoke it
          // again before allowing another begin through the queue.
          if (!isCurrent()) await screenAnnotationEnd(lease.shareId);
        }
      });
      annotationBeginQueue = beginning.catch(() => {});
      await beginning;
      if (!isCurrent()) return;
      lease.ready = !lease.adjustingRegion;
      setScreenShareKey(lease.shareId);
      setScreenPreviewKey(lease.shareId);
      setActive(true);
    } catch (failure) {
      if (!isCurrent()) return;
      stop();
      setError(String(failure));
    } finally {
      if (owner.current === lease) setBusy(false);
    }
  }, [sources, stop]);

  const capture = useCallback(
    function requestCapture(reason: ScreenSharingTiming["reason"]): Promise<void> {
      const lease = owner.current;
      if (!lease?.ready) return Promise.resolve();
      const isCurrent = () =>
        owner.current === lease &&
        lease.ready &&
        !lease.controller.signal.aborted &&
        latest.current.ownerKey === lease.ownerKey &&
        latest.current.available;
      if (!isCurrent()) return Promise.resolve();
      const pending = inFlight.current;
      if (pending) {
        // Speech joins an existing capture. A new lease waits for the previous
        // native operation to settle, then starts immediately instead of losing
        // its first capture until the next periodic tick.
        return pending.lease === lease
          ? pending.promise
          : pending.promise.then(() => {
              if (isCurrent()) return requestCapture(reason);
            });
      }
      // Moving the slider reschedules this effect. It must not capture at every
      // slider step. Speech explicitly bypasses this periodic sampling limit so
      // the screenshot can reach Codex while the user is still asking a question.
      const now = Date.now();
      if (
        reason === "periodic" &&
        lastCaptureStartedAt.current !== null &&
        now - lastCaptureStartedAt.current <
          (latest.current.intervalSeconds * 1000) / latest.current.contactSheetFrameCount
      )
        return Promise.resolve();
      lastCaptureStartedAt.current = now;
      const run = { lease, promise: Promise.resolve() };
      inFlight.current = run;
      setBusy(true);
      run.promise = (async () => {
        const started = performance.now();
        let captured: number | null = null;
        let outcome: ScreenSharingTiming["outcome"] = "cancelled";
        try {
          const frame = lease.camera
            ? {
                ...lease.camera.capture(),
                frameId: crypto.randomUUID(),
                sourceId: lease.sourceId,
                sourceName:
                  sources.find((source) => source.id === lease.sourceId)?.name ?? "Camera",
                pointersEnabled: false,
                pointerFrameValid: false,
                pointerEpoch: undefined,
              }
            : await screenCaptureFrame(lease.sourceId, lease.shareId);
          captured = performance.now();
          if (!isCurrent()) return;
          if (lease.sourceKind === "camera") setLastCapturedAt(frame.capturedAt);
          if (lease.sourceKind === "screen" || lease.sourceKind === "camera") {
            // The preview follows the latest capture immediately. Periodic
            // captures are buffered until the contact sheet is complete, so
            // waiting for share() here would leave the preview stale for the
            // first 15 frames of every batch.
            setScreenPreviewFrame({
              imageDataUrl: frame.dataUrl,
              lastCapturedAt: frame.capturedAt,
              lastSharedAt: 0,
            });
          }
          if (
            lease.sourceKind === "screen" &&
            lease.selection?.kind !== "display" &&
            (!("selectionKind" in frame) || frame.selectionKind !== lease.selection?.kind)
          ) {
            throw new Error(
              "The screen capture source could not be verified. Window and region sharing are not available in the running app yet.",
            );
          }
          if (frame.sourceId !== lease.sourceId) {
            throw new Error(
              "The shared display changed. Start sharing the selected display again.",
            );
          }
          let outgoingFrame = frame;
          if (reason === "periodic") {
            contactSheetSamples.current.push({
              dataUrl: frame.dataUrl,
              capturedAt: frame.capturedAt,
            });
            if (contactSheetSamples.current.length < latest.current.contactSheetFrameCount) {
              outcome = "shared";
              return;
            }
            const sheet = await buildContactSheet(
              contactSheetSamples.current,
              latest.current.contactSheetFrameCount,
            );
            // Composition decodes images asynchronously; the lease may have
            // ended or been replaced while the canvas was being built.
            if (!isCurrent()) return;
            contactSheetSamples.current = [];
            outgoingFrame = {
              ...frame,
              dataUrl: sheet.dataUrl,
              width: sheet.width,
              height: sheet.height,
              frameId: crypto.randomUUID(),
              pointersEnabled: false,
              pointerFrameValid: false,
            };
          }
          // Reuse identical pixels while their native reference remains valid. A
          // replacement token (for example after sleep/expiry) must reach the agent.
          if (
            lastImage.current?.dataUrl === outgoingFrame.dataUrl &&
            lastImage.current.frameId === outgoingFrame.frameId
          ) {
            outcome = "unchanged";
            return;
          }
          const result = await latest.current.share(
            {
              sourceKind: lease.sourceKind,
              frameId: outgoingFrame.frameId,
              pointersEnabled: outgoingFrame.pointersEnabled,
              pointerFrameValid: outgoingFrame.pointerFrameValid,
              pointerEpoch: outgoingFrame.pointerEpoch,
              width: outgoingFrame.width,
              height: outgoingFrame.height,
              imageDataUrl: outgoingFrame.dataUrl,
              source: frame.sourceName,
              capturedAt: new Date(outgoingFrame.capturedAt).toISOString(),
            },
            lease.controller.signal,
          );
          if (!isCurrent()) return;
          outcome = result.status;
          if (result.status === "shared") {
            lastImage.current = { dataUrl: outgoingFrame.dataUrl, frameId: outgoingFrame.frameId };
            setLastObservedAt(outgoingFrame.capturedAt);
            if (lease.sourceKind === "screen" || lease.sourceKind === "camera") {
              setScreenPreviewFrame({
                imageDataUrl: outgoingFrame.dataUrl,
                lastCapturedAt: outgoingFrame.capturedAt,
                lastSharedAt: Date.now(),
              });
            }
          }
        } catch (failure) {
          // A timeout may settle the public image promise before its RPC has
          // finished. Fail closed during a drag instead of committing a new
          // region while that old delivery is still uncertain.
          if (
            owner.current !== lease ||
            lease.controller.signal.aborted ||
            latest.current.ownerKey !== lease.ownerKey ||
            !latest.current.available
          )
            return;
          outcome = "failed";
          stop();
          setError(String(failure));
        } finally {
          if (inFlight.current === run) inFlight.current = null;
          if (isCurrent()) setBusy(false);
          const ended = performance.now();
          try {
            latest.current.onTiming?.({
              reason,
              captureMs: (captured ?? ended) - started,
              contextMs: captured === null ? 0 : ended - captured,
              totalMs: ended - started,
              outcome,
            });
          } catch {
            // Diagnostics must never interrupt sharing or voice.
          }
        }
      })();
      return run.promise;
    },
    [stop, sources],
  );

  const captureNow = useCallback(() => capture("speech"), [capture]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const matchingLease = (event: RegionFrameEvent) => {
      const lease = owner.current;
      return !disposed &&
        lease?.frameId === event.shareId &&
        lease.sourceId === event.sourceId &&
        lease.selection?.kind === "region" &&
        !lease.controller.signal.aborted &&
        latest.current.ownerKey === lease.ownerKey &&
        latest.current.available
        ? lease
        : null;
    };
    const adjusting = (event: RegionFrameEvent) => {
      const lease = matchingLease(event);
      if (!lease) return;
      ++selectionAttempt.current;
      lease.ready = false;
      lease.adjustingRegion = true;
      setAdjustingRegion(true);
    };
    const commit = async (event: RegionFrameEvent) => {
      const previous = matchingLease(event);
      const selected = event.region;
      if (!previous || !selected) return;
      if (!validRegion(selected)) {
        stop();
        setError("The selected screen region is invalid. Start region sharing again.");
        return;
      }
      const attempt = ++selectionAttempt.current;
      previous.ready = false;
      setAdjustingRegion(true);
      let lease = previous;
      const isCurrent = () =>
        !disposed &&
        selectionAttempt.current === attempt &&
        owner.current === lease &&
        !lease.controller.signal.aborted &&
        latest.current.ownerKey === lease.ownerKey &&
        latest.current.available;
      try {
        // A submitted image RPC cannot be recalled. Let it settle BEFORE the
        // new region commits. Aborting first would resolve the observation
        // promise early while its old image was still travelling to the agent.
        await inFlight.current?.promise;
        if (!isCurrent()) return;
        previous.controller.abort();
        lease = {
          ...previous,
          shareId: crypto.randomUUID(),
          selection: { kind: "region", region: selected },
          controller: new AbortController(),
          ready: false,
          adjustingRegion: false,
        };
        owner.current = lease;
        const documentId = await lease.documentId;
        if (!isCurrent() || !documentId) return;
        const beginning = annotationBeginQueue.then(async () => {
          await screenAnnotationEnd(previous.shareId);
          if (!isCurrent()) return;
          try {
            await screenAnnotationBegin(lease.shareId, lease.sourceId, documentId, lease.selection);
          } finally {
            if (!isCurrent()) await screenAnnotationEnd(lease.shareId);
          }
        });
        annotationBeginQueue = beginning.catch(() => {});
        await beginning;
        if (!isCurrent()) return;
        lastImage.current = null;
        lastCaptureStartedAt.current = null;
        setRegion(selected);
        latest.current = { ...latest.current, region: selected };
        setScreenPreviewFrame(null);
        setScreenShareKey(lease.shareId);
        setLastObservedAt(undefined);
        setError(undefined);
        lease.ready = true;
        setActive(true);
        setBusy(false);
        setAdjustingRegion(false);
        await capture("speech");
      } catch (failure) {
        if (!isCurrent()) return;
        stop();
        setError(String(failure));
      }
    };
    const subscribe = async (name: string, callback: (event: RegionFrameEvent) => void) => {
      const unlisten = await listen<RegionFrameEvent>(name, (event) => callback(event.payload));
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    };
    regionEventsReady.current = Promise.all([
      subscribe("screen-region-adjusting", adjusting),
      subscribe("screen-region-changed", (event) => void commit(event)),
      subscribe("screen-region-closed", (event) => {
        if (!matchingLease(event)) return;
        stop();
        setError("The shared display changed. Start region sharing again.");
      }),
    ]).then(() => {});
    // Display/camera sharing does not require these listeners. Region Start
    // awaits this same promise and surfaces registration errors before capture.
    void regionEventsReady.current.catch(() => {});
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [capture, stop]);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let timer: number | undefined;
    const tick = async () => {
      await capture("periodic");
      if (disposed) return;
      // A slow capture resumes at its next due time; no extra whole interval is
      // added because an interval tick arrived while capture was in flight.
      const nextDue =
        (lastCaptureStartedAt.current ?? Date.now()) +
        (intervalSeconds * 1000) / contactSheetFrameCount;
      timer = window.setTimeout(
        () => void tick(),
        owner.current?.ready
          ? Math.max(0, nextDue - Date.now())
          : (intervalSeconds * 1000) / contactSheetFrameCount,
      );
    };
    void tick();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [active, intervalSeconds, contactSheetFrameCount, capture]);

  const clearAnnotations = useCallback(async () => {
    const lease = owner.current;
    if (!lease || lease.sourceKind !== "screen") return;
    try {
      await screenAnnotationClear();
      if (owner.current === lease) setError(undefined);
    } catch {
      if (owner.current === lease) setError("Could not clear the screen markers.");
    }
  }, []);

  const setSourceKind = useCallback(
    (kind: SharingSourceKind) => {
      if (kind === latest.current.sourceKind) return;
      stop();
      ++sourceRefresh.current;
      setSources([]);
      setSourceId(null);
      setRegion(null);
      setLastObservedAt(undefined);
      setError(undefined);
      setSourceKindState(kind);
      // Update immediately so two events before a React render cannot start the old source.
      latest.current = {
        ...latest.current,
        sourceKind: kind,
        sourceId: null,
        region: null,
        available: false,
      };
      void refreshSources(kind);
    },
    [stop, refreshSources],
  );

  const setScreenSourceKind = useCallback(
    (kind: ScreenSourceKind) => {
      if (kind !== "display" && !latest.current.screenSelectionSupported) {
        setError(
          "Window and region sharing are not available in the running app yet. Full display and camera sharing are available.",
        );
        return;
      }
      if (kind === latest.current.screenSourceKind) return;
      stop();
      ++sourceRefresh.current;
      setSources([]);
      setSourceId(null);
      setRegion(null);
      setError(undefined);
      setScreenSourceKindState(kind);
      latest.current = { ...latest.current, screenSourceKind: kind, sourceId: null, region: null };
      void refreshSources("screen", true);
    },
    [stop, refreshSources],
  );

  const selectRegion = useCallback(async () => {
    const current = latest.current;
    if (
      owner.current ||
      !current.screenSelectionSupported ||
      current.sourceKind !== "screen" ||
      current.screenSourceKind !== "region" ||
      current.sourceId === null
    )
      return;
    stop();
    const attempt = ++selectionAttempt.current;
    const isCurrent = () =>
      selectionAttempt.current === attempt && latest.current.ownerKey === current.ownerKey;
    setBusy(true);
    setError(undefined);
    try {
      const granted = await screenCaptureRequestPermission();
      if (!isCurrent()) return;
      if (!granted)
        throw new Error(
          "Screen Recording permission is required. Allow Yorishiro in System Settings → Privacy & Security → Screen Recording, then retry.",
        );
      const selected = await screenCaptureSelectRegion(current.sourceId);
      if (!isCurrent()) return;
      if (selected) {
        setRegion(selected.region);
        setSourceId(selected.sourceId);
        latest.current = {
          ...latest.current,
          sourceId: selected.sourceId,
          region: selected.region,
        };
      }
    } catch (failure) {
      if (isCurrent()) setError(String(failure));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }, [stop]);

  const refreshSelectedSources = useCallback(
    (requestPermission = false) => refreshSources(undefined, requestPermission),
    [refreshSources],
  );

  return {
    available,
    sourceKind,
    screenSourceKind,
    screenSelectionSupported: latest.current.screenSelectionSupported === true,
    region,
    setScreenSourceKind,
    selectRegion,
    cameraStream,
    screenPreviewFrame,
    screenShareKey,
    screenPreviewKey,
    lastCapturedAt,
    setSourceKind,
    sources,
    sourceId,
    intervalSeconds,
    contactSheetFrameCount,
    active,
    busy: busy || adjustingRegion,
    error,
    lastObservedAt,
    start,
    stop,
    captureNow,
    clearAnnotations,
    refreshSources: refreshSelectedSources,
    setSourceId: (value: number) => {
      if (value === latest.current.sourceId) return;
      stop();
      setSourceId(value);
      setRegion(null);
      latest.current = { ...latest.current, sourceId: value, region: null };
    },
    setIntervalSeconds: (value: number) => {
      if (Number.isFinite(value)) setIntervalSeconds(normalizeIntervalSeconds(value));
    },
    setContactSheetFrameCount: (value: number) => {
      if (
        CONTACT_SHEET_FRAME_COUNTS.includes(value as (typeof CONTACT_SHEET_FRAME_COUNTS)[number])
      ) {
        setContactSheetFrameCount(value);
      }
    },
  };
}

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ScreenCaptureSource,
  screenCaptureFrame,
  screenCaptureListSources,
  screenCaptureRequestPermission,
} from "../../bindings/tauri-commands";
import type { ScreenObservationFrame, ScreenObservationResult } from "./screen-observation";

interface Options {
  available: boolean;
  /** Changes on main-agent/thread replacement; voice reconnection keeps this lease. */
  ownerKey: string;
  share: (frame: ScreenObservationFrame, signal: AbortSignal) => Promise<ScreenObservationResult>;
}

/** Host-owned opt-in sampling; no queued frames, no capture after a stale permission grant. */
export function useScreenSharing({ available, ownerKey, share }: Options) {
  const [sources, setSources] = useState<ScreenCaptureSource[]>([]);
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [intervalSeconds, setIntervalSeconds] = useState(30);
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [lastObservedAt, setLastObservedAt] = useState<number>();
  const owner = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const lastImage = useRef<string | null>(null);
  const lastCaptureStartedAt = useRef<number | null>(null);
  const latest = useRef({ available, ownerKey, share });
  latest.current = { available, ownerKey, share };

  const stop = useCallback(() => {
    owner.current?.abort();
    owner.current = null;
    lastImage.current = null;
    lastCaptureStartedAt.current = null;
    setActive(false);
    setBusy(false);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Changing either owner or availability ends the sharing lease.
  useEffect(() => {
    stop();
    setLastObservedAt(undefined);
    return stop;
  }, [ownerKey, available, stop]);

  const refreshSources = useCallback(async () => {
    const key = latest.current.ownerKey;
    try {
      const next = await screenCaptureListSources();
      if (latest.current.ownerKey !== key) return;
      setSources(next);
      setSourceId((current) =>
        next.some((source) => source.id === current) ? current : (next[0]?.id ?? null),
      );
      setError(undefined);
    } catch (failure) {
      if (latest.current.ownerKey === key) setError(String(failure));
    }
  }, []);

  const start = useCallback(async () => {
    if (!latest.current.available || sourceId === null || owner.current) return;
    const controller = new AbortController();
    owner.current = controller;
    const key = latest.current.ownerKey;
    setError(undefined);
    setBusy(true);
    setLastObservedAt(undefined);
    try {
      const granted = await screenCaptureRequestPermission();
      if (
        controller.signal.aborted ||
        owner.current !== controller ||
        latest.current.ownerKey !== key ||
        !latest.current.available
      )
        return;
      if (!granted)
        throw new Error(
          "Screen Recording permission is required. Allow Yorishiro in System Settings → Privacy & Security → Screen Recording, then retry.",
        );
      setActive(true);
    } catch (failure) {
      if (owner.current !== controller || controller.signal.aborted) return;
      stop();
      setError(String(failure));
    } finally {
      if (owner.current === controller) setBusy(false);
    }
  }, [sourceId, stop]);

  useEffect(() => {
    const controller = owner.current;
    if (!active || sourceId === null || !controller) return;
    const key = ownerKey;
    const isCurrent = () =>
      owner.current === controller &&
      !controller.signal.aborted &&
      latest.current.ownerKey === key &&
      latest.current.available;
    const tick = async () => {
      if (!isCurrent() || inFlight.current) return;
      // Moving the slider reschedules this effect. It must not capture at every
      // slider step (which can otherwise send dozens of images per second).
      const now = Date.now();
      if (
        lastCaptureStartedAt.current !== null &&
        now - lastCaptureStartedAt.current < intervalSeconds * 1000
      )
        return;
      lastCaptureStartedAt.current = now;
      inFlight.current = true;
      setBusy(true);
      try {
        const frame = await screenCaptureFrame(sourceId);
        if (!isCurrent()) return;
        // Identical pixels need no additional image tokens. Keep only one in-memory copy.
        if (lastImage.current === frame.dataUrl) return;
        const result = await latest.current.share(
          {
            imageDataUrl: frame.dataUrl,
            source: frame.sourceName,
            capturedAt: new Date(frame.capturedAt).toISOString(),
          },
          controller.signal,
        );
        if (!isCurrent()) return;
        if (result.status === "shared") {
          lastImage.current = frame.dataUrl;
          setLastObservedAt(frame.capturedAt);
        }
      } catch (failure) {
        if (!isCurrent()) return;
        stop();
        setError(String(failure));
      } finally {
        inFlight.current = false;
        if (isCurrent()) setBusy(false);
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), intervalSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [active, sourceId, intervalSeconds, ownerKey, stop]);

  return {
    sources,
    sourceId,
    intervalSeconds,
    active,
    busy,
    error,
    lastObservedAt,
    start,
    stop,
    refreshSources,
    setSourceId: (value: number) => {
      if (!owner.current) setSourceId(value);
    },
    setIntervalSeconds: (value: number) => {
      if (Number.isFinite(value)) setIntervalSeconds(Math.max(5, Math.min(60, Math.round(value))));
    },
  };
}

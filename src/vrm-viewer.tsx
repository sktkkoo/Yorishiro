/**
 * VrmViewer — thin placeholder for ThreeRuntime singleton.
 *
 * The actual renderer / scene / RAF loop / VRM lifecycle lives in
 * src/runtime/three-runtime/. This component only:
 *   - Provides a bounding rect via <div ref={placeholderRef} />
 *   - Pushes url / onBodyReady / devLog changes into the singleton via
 *     attachTo / setVrmUrl / setBodyListener / setDevLog.
 *
 * Editing this file during dev does NOT tear down the canvas, WebGLRenderer,
 * Scene, VRM, or Body.
 *
 * Internal design-record: 2026-04-17-three-runtime-singleton.md.
 */

import { useEffect, useRef } from "react";
import type { Body } from "./core/body";
import type { SubsystemLog } from "./core/dev-log";
import { computeShakeOffset, type EffectDispatcher } from "./core/space";
import { getThreeRuntime } from "./runtime/three-runtime";

interface VrmViewerProps {
  readonly url: string;
  readonly onBodyReady?: (body: Body | null) => void;
  readonly devLog?: SubsystemLog;
  readonly effectDispatcher?: EffectDispatcher;
}

export default function VrmViewer({ url, onBodyReady, devLog, effectDispatcher }: VrmViewerProps) {
  const placeholderRef = useRef<HTMLDivElement>(null);

  // ── Attach to the singleton canvas ────────────────────────────

  useEffect(() => {
    const placeholder = placeholderRef.current;
    if (!placeholder) return;
    const runtime = getThreeRuntime();
    runtime.attachTo(placeholder);
    return () => runtime.detachContainer();
  }, []);

  // ── Push url to the runtime ───────────────────────────────────

  useEffect(() => {
    getThreeRuntime().setVrmUrl(url);
  }, [url]);

  // ── Body listener（onBodyReady を singleton に委譲）────────────

  useEffect(() => {
    getThreeRuntime().setBodyListener(onBodyReady ?? null);
    return () => getThreeRuntime().setBodyListener(null);
  }, [onBodyReady]);

  // ── dev-log ───────────────────────────────────────────────────

  useEffect(() => {
    getThreeRuntime().setDevLog(devLog ?? null);
  }, [devLog]);

  // ── Shake effect subscription ─────────────────────────────────

  useEffect(() => {
    if (!effectDispatcher) return;
    return effectDispatcher.subscribe("shake", (request) => {
      const el = placeholderRef.current;
      if (!el) return;
      if (request.kind !== "shake") return;
      const start = performance.now();
      let rafId: number | null = null;
      const tick = (now: number) => {
        const elapsed = now - start;
        const { dx, dy } = computeShakeOffset(
          elapsed,
          request.durationMs,
          request.intensity,
          Math.random,
        );
        if (dx === 0 && dy === 0) {
          el.style.transform = "";
          rafId = null;
          return;
        }
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
      // NOTE: no explicit cleanup per request — the rAF loop self-terminates
      // once computeShakeOffset returns {0,0} at elapsed >= durationMs.
      void rafId;
    });
  }, [effectDispatcher]);

  return <div ref={placeholderRef} className="vrm-container" />;
}

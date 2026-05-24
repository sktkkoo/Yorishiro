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
import { getThreeRuntime } from "./runtime/three-runtime/three-runtime";

interface VrmViewerProps {
  readonly url: string;
  readonly onBodyReady?: (body: Body | null) => void;
  readonly devLog?: SubsystemLog;
}

export default function VrmViewer({ url, onBodyReady, devLog }: VrmViewerProps) {
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

  return <div ref={placeholderRef} className="vrm-container" />;
}

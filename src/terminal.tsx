import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import type { SpawnSpec } from "./bindings/tauri-commands";
import type { Perception } from "./core/perception";
import { getTerminalRuntime } from "./runtime/terminal-runtime";

interface TerminalProps {
  readonly spec: SpawnSpec;
  readonly cwd: string | null;
  readonly perception: Perception | null;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export default function Terminal({ spec, cwd, perception }: TerminalProps) {
  const placeholderRef = useRef<HTMLDivElement>(null);

  // ── Attach to the singleton xterm / PTY runtime ───────────────

  useEffect(() => {
    const placeholder = placeholderRef.current;
    if (!placeholder) return;
    const runtime = getTerminalRuntime();
    runtime.attachTo(placeholder);
    return () => runtime.detachContainer();
  }, []);

  // ── Push prop changes to the runtime (PTY params + perception) ─

  useEffect(() => {
    if (!isTauri) return;
    getTerminalRuntime().updatePtyParams({ spec, cwd });
  }, [spec, cwd]);

  useEffect(() => {
    getTerminalRuntime().setPerception(perception);
  }, [perception]);

  return <div ref={placeholderRef} className="terminal-container" />;
}

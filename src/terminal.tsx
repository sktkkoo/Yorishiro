import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import type { SpawnSpec } from "./bindings/tauri-commands";
import type { Perception } from "./core/perception";
import { getTerminalRuntime } from "./runtime/terminal-runtime";

interface TerminalProps {
  readonly sessionId: string;
  readonly spec: SpawnSpec;
  readonly cwd: string | null;
  readonly perception: Perception | null;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export default function Terminal({ sessionId, spec, cwd, perception }: TerminalProps) {
  const placeholderRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const placeholder = placeholderRef.current;
    if (!placeholder) return;
    const runtime = getTerminalRuntime(sessionId);
    runtime.attachTo(placeholder);
    return () => runtime.detachContainer();
  }, [sessionId]);

  useEffect(() => {
    if (!isTauri) return;
    getTerminalRuntime(sessionId).updatePtyParams({ spec, cwd });
  }, [sessionId, spec, cwd]);

  useEffect(() => {
    getTerminalRuntime(sessionId).setPerception(perception);
  }, [sessionId, perception]);

  return <div ref={placeholderRef} className="terminal-container" />;
}

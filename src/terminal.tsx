import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import type { Perception } from "./core/perception";
import { getTerminalRuntime } from "./runtime/terminal-runtime";
import type { TerminalAgent } from "./runtime/user-pack-loader/config";

interface TerminalProps {
  readonly agent: TerminalAgent;
  readonly cwd: string | null;
  readonly systemPrompt: string | null;
  readonly perception: Perception | null;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export default function Terminal({ agent, cwd, systemPrompt, perception }: TerminalProps) {
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
    getTerminalRuntime().updatePtyParams({ agent, cwd, systemPrompt });
  }, [agent, cwd, systemPrompt]);

  useEffect(() => {
    getTerminalRuntime().setPerception(perception);
  }, [perception]);

  return <div ref={placeholderRef} className="terminal-container" />;
}

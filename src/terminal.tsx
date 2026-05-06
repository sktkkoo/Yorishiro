import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import type { SpawnSpec } from "./bindings/tauri-commands";
import type { Perception } from "./core/perception";
import { getTerminalRuntime } from "./runtime/terminal-runtime";
import { getCurrentTerminalTheme } from "./runtime/terminal-theme";

interface TerminalProps {
  readonly sessionId: string;
  readonly visible: boolean;
  readonly spec: SpawnSpec;
  readonly cwd: string | null;
  readonly perception: Perception | null;
  readonly attachFirst?: boolean;
}

export default function Terminal({
  sessionId,
  visible,
  spec,
  cwd,
  perception,
  attachFirst = false,
}: TerminalProps) {
  const placeholderRef = useRef<HTMLDivElement>(null);

  // visible が変わるたびに attach/detach を切り替える。
  // inactive session は detachContainer() で RAF 停止 + visibility:hidden。
  useEffect(() => {
    const placeholder = placeholderRef.current;
    if (!placeholder) return;
    const runtime = getTerminalRuntime(sessionId);
    if (visible) {
      runtime.attachTo(placeholder);
      runtime.setTheme(getCurrentTerminalTheme());
      runtime.focus();
    } else {
      runtime.detachContainer();
    }
    return () => runtime.detachContainer();
  }, [sessionId, visible]);

  useEffect(() => {
    getTerminalRuntime(sessionId).updatePtyParams({ spec, cwd }, { attachFirst });
  }, [sessionId, spec, cwd, attachFirst]);

  useEffect(() => {
    getTerminalRuntime(sessionId).setPerception(perception);
  }, [sessionId, perception]);

  return (
    <div
      ref={placeholderRef}
      className="terminal-container"
      data-session-id={sessionId}
      data-active={visible ? "true" : "false"}
    />
  );
}

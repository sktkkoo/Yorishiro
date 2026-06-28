import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { type SpawnSpec, sessionRefreshTheme } from "./bindings/tauri-commands";
import type { Perception } from "./core/perception";
import {
  detectScreenAttentionRequest,
  getSessionStatusStore,
  isAttentionClearingInput,
} from "./runtime/session-status";
import { getTerminalRuntime } from "./runtime/terminal-runtime";
import { getCurrentTerminalTheme } from "./runtime/terminal-theme";

const OUTPUT_SETTLE_MS = 800;
const SCREEN_ATTENTION_SCAN_MS = 80;

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
  const outputSettleTimerRef = useRef<number | null>(null);
  const screenAttentionScanTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const status = getSessionStatusStore();
    status.register(sessionId);
    const runtime = getTerminalRuntime(sessionId);
    const scanScreenAttention = () => {
      screenAttentionScanTimerRef.current = null;
      const detection = detectScreenAttentionRequest(runtime.readScreenTailText(14));
      if (detection) {
        status.markScreenAttentionRequest(sessionId, {
          title: detection.title,
          body: detection.body,
        });
      } else {
        status.clearScreenAttention(sessionId);
      }
    };
    const sub = runtime.subscribePtyData(() => {
      status.markOutput(sessionId);
      if (screenAttentionScanTimerRef.current !== null) {
        window.clearTimeout(screenAttentionScanTimerRef.current);
      }
      screenAttentionScanTimerRef.current = window.setTimeout(
        scanScreenAttention,
        SCREEN_ATTENTION_SCAN_MS,
      );
      if (outputSettleTimerRef.current !== null) {
        window.clearTimeout(outputSettleTimerRef.current);
      }
      outputSettleTimerRef.current = window.setTimeout(() => {
        outputSettleTimerRef.current = null;
        status.settleOutput(sessionId);
      }, OUTPUT_SETTLE_MS);
    });
    const notificationSub = runtime.subscribeNotification((event) => {
      status.markAttentionRequest(sessionId, {
        title: event.title,
        body: event.body,
        source: "osc",
      });
    });
    const inputSub = runtime.subscribeUserInput((data) => {
      if (isAttentionClearingInput(data)) {
        status.clearAttention(sessionId);
      }
    });
    return () => {
      if (outputSettleTimerRef.current !== null) {
        window.clearTimeout(outputSettleTimerRef.current);
        outputSettleTimerRef.current = null;
      }
      if (screenAttentionScanTimerRef.current !== null) {
        window.clearTimeout(screenAttentionScanTimerRef.current);
        screenAttentionScanTimerRef.current = null;
      }
      sub.dispose();
      notificationSub.dispose();
      inputSub.dispose();
    };
  }, [sessionId]);

  // visible が変わるたびに attach/detach を切り替える。
  // inactive session は detachContainer() で RAF 停止 + visibility:hidden。
  useEffect(() => {
    const placeholder = placeholderRef.current;
    if (!placeholder) return;
    const runtime = getTerminalRuntime(sessionId);
    if (visible) {
      getSessionStatusStore().markActive(sessionId);
      runtime.attachTo(placeholder);
      runtime.setTheme(getCurrentTerminalTheme());
      runtime.focus();
      void sessionRefreshTheme({ sessionId }).catch((err) => {
        console.warn("[terminal-theme] failed to refresh agent theme:", err);
      });
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

import { type MutableRefObject, useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { type SpawnSpec, sessionRefreshTheme } from "./bindings/tauri-commands";
import type { Perception } from "./core/perception";
import { type AttentionLightCue, getAttentionLightCueStore } from "./runtime/attention-light-cue";
import { getLoopReelStore } from "./runtime/loop-reel";
import {
  detectScreenAttentionRequest,
  getSessionStatusStore,
  isAttentionClearingInput,
  isOscAttentionNotificationMessage,
} from "./runtime/session-status";
import { getSurfaceRegistry } from "./runtime/surface-registry";
import { getTerminalRuntime, type InterruptProtectionMode } from "./runtime/terminal-runtime";
import { getCurrentTerminalTheme } from "./runtime/terminal-theme";
import {
  ATTENTION_CUE_DURATION_SECONDS,
  computeAttentionCueLightIntensity,
} from "./runtime/three-runtime/attention-cue-envelope";

const OUTPUT_SETTLE_MS = 800;
const SCREEN_ATTENTION_SCAN_MS = 80;
const TERMINAL_ATTENTION_CUE_SCALE = 3.6;

interface TerminalProps {
  readonly sessionId: string;
  readonly visible: boolean;
  readonly active: boolean;
  readonly spec: SpawnSpec;
  readonly cwd: string | null;
  readonly perception: Perception | null;
  readonly attachFirst?: boolean;
  readonly onActivate?: (sessionId: string) => void;
  readonly interruptProtectionMode?: InterruptProtectionMode;
}

export default function Terminal({
  sessionId,
  visible,
  active,
  spec,
  cwd,
  perception,
  attachFirst = false,
  onActivate,
  interruptProtectionMode = "none",
}: TerminalProps) {
  const placeholderRef = useRef<HTMLDivElement>(null);
  const outputSettleTimerRef = useRef<number | null>(null);
  const outputSettleDueAtRef = useRef(0);
  const screenAttentionScanTimerRef = useRef<number | null>(null);
  const screenAttentionScanDueAtRef = useRef(0);

  useEffect(() => {
    const status = getSessionStatusStore();
    status.register(sessionId);
    const runtime = getTerminalRuntime(sessionId);
    runtime.setLoopReelRecorder(getLoopReelStore());
    const scheduleDebounced = (
      timerRef: MutableRefObject<number | null>,
      dueAtRef: MutableRefObject<number>,
      delayMs: number,
      callback: () => void,
    ) => {
      dueAtRef.current = performance.now() + delayMs;
      if (timerRef.current !== null) return;

      const tick = () => {
        const remainingMs = dueAtRef.current - performance.now();
        if (remainingMs > 0) {
          timerRef.current = window.setTimeout(tick, remainingMs);
          return;
        }
        timerRef.current = null;
        callback();
      };
      timerRef.current = window.setTimeout(tick, delayMs);
    };
    const scanScreenAttention = () => {
      const detection = detectScreenAttentionRequest(runtime.readScreenTailText(28));
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
      scheduleDebounced(
        screenAttentionScanTimerRef,
        screenAttentionScanDueAtRef,
        SCREEN_ATTENTION_SCAN_MS,
        scanScreenAttention,
      );
      scheduleDebounced(outputSettleTimerRef, outputSettleDueAtRef, OUTPUT_SETTLE_MS, () => {
        status.settleOutput(sessionId);
      });
    });
    const notificationSub = runtime.subscribeNotification((event) => {
      if (!isOscAttentionNotificationMessage(event.body)) return;
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
  // 非表示 session は detachContainer() で RAF 停止 + visibility:hidden。
  useEffect(() => {
    const placeholder = placeholderRef.current;
    if (!placeholder) return;
    const runtime = getTerminalRuntime(sessionId);
    if (visible) {
      getSessionStatusStore().markActive(sessionId);
      getSurfaceRegistry().register("terminal", placeholder);
      runtime.attachTo(placeholder);
      runtime.setTheme(getCurrentTerminalTheme());
      void sessionRefreshTheme({ sessionId }).catch((err) => {
        console.warn("[terminal-theme] failed to refresh agent theme:", err);
      });
    } else {
      runtime.detachContainer();
    }
    return () => {
      getSurfaceRegistry().unregister("terminal", placeholder);
      runtime.detachContainer();
    };
  }, [sessionId, visible]);

  useEffect(() => {
    if (visible && active) getTerminalRuntime(sessionId).focus();
  }, [sessionId, visible, active]);

  useEffect(() => {
    if (!onActivate) return;
    const sub = getTerminalRuntime(sessionId).subscribeActivation(() => onActivate(sessionId));
    return () => sub.dispose();
  }, [sessionId, onActivate]);

  useEffect(() => {
    getTerminalRuntime(sessionId).updatePtyParams({ spec, cwd }, { attachFirst });
  }, [sessionId, spec, cwd, attachFirst]);

  useEffect(() => {
    getTerminalRuntime(sessionId).setPerception(perception);
  }, [sessionId, perception]);

  useEffect(() => {
    getTerminalRuntime(sessionId).setInterruptProtectionMode(interruptProtectionMode);
  }, [sessionId, interruptProtectionMode]);

  useEffect(() => {
    const runtime = getTerminalRuntime(sessionId);
    const cueStore = getAttentionLightCueStore();
    let rafId = 0;
    let activeCue: AttentionLightCue | null = null;

    const clearFrame = () => {
      if (rafId === 0) return;
      window.cancelAnimationFrame(rafId);
      rafId = 0;
    };
    const setIntensity = (intensity: number) => {
      runtime.setAttentionCueIntensity(visible ? intensity : 0);
    };
    const tick = () => {
      rafId = 0;
      if (!activeCue || !visible) {
        runtime.setAttentionCueIntensity(0);
        return;
      }
      const elapsedSeconds = Math.max(0, (Date.now() - activeCue.startedAt) / 1000);
      if (elapsedSeconds >= ATTENTION_CUE_DURATION_SECONDS) {
        activeCue = null;
        runtime.setAttentionCueIntensity(0);
        return;
      }
      const intensity = computeAttentionCueLightIntensity(elapsedSeconds);
      setIntensity(Math.min(1, (intensity.point + intensity.spot) * TERMINAL_ATTENTION_CUE_SCALE));
      rafId = window.requestAnimationFrame(tick);
    };
    const restart = () => {
      activeCue = cueStore.getCurrent();
      clearFrame();
      tick();
    };

    restart();
    const unsubscribe = cueStore.subscribe(restart);
    return () => {
      unsubscribe();
      clearFrame();
      runtime.setAttentionCueIntensity(0);
    };
  }, [sessionId, visible]);

  return (
    <div
      ref={placeholderRef}
      className="terminal-container"
      data-session-id={sessionId}
      data-visible={visible ? "true" : "false"}
      data-presented={visible ? "true" : "false"}
      data-active={active ? "true" : "false"}
    />
  );
}

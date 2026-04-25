/**
 * Tool attention producer。
 *
 * hook-signal event を listen し、pre-tool-use → tool-running (priority=6)、
 * post-tool-failure → tool-diagnostic (priority=8)、stop → 両 source clear。
 *
 * subscribeHookSignal と getCurrentLineRect は inject。Phase 1d で App.tsx
 * から EventBus + terminal-runtime を adapter で繋ぐ。
 */

import type { AttentionRuntime } from "../attention-runtime/types";
import type { Disposable } from "./types";

const PRIORITY_RUNNING = 6;
const PRIORITY_DIAGNOSTIC = 8;
const CONFIDENCE_RUNNING = 0.72;
const CONFIDENCE_DIAGNOSTIC = 0.8;

interface HookSignalEvent {
  readonly name: string;
}

interface StartOptions {
  readonly attention: AttentionRuntime;
  readonly subscribeHookSignal: (handler: (event: HookSignalEvent) => void) => Disposable;
  readonly getCurrentLineRect: () => { x: number; y: number; width: number; height: number } | null;
}

export function startToolAttentionProducer(opts: StartOptions): Disposable {
  const { attention, subscribeHookSignal, getCurrentLineRect } = opts;

  const sub = subscribeHookSignal((event) => {
    if (event.name === "pre-tool-use") {
      const rect = getCurrentLineRect();
      if (rect === null) return;
      attention.setSourceTarget("tool-running", {
        kind: "terminal-region",
        source: "tool-running",
        rect,
        confidence: CONFIDENCE_RUNNING,
        priority: PRIORITY_RUNNING,
        timestamp: performance.now(),
        reason: "tool-running",
      });
    } else if (event.name === "post-tool-failure") {
      const rect = getCurrentLineRect();
      if (rect === null) return;
      attention.setSourceTarget("tool-diagnostic", {
        kind: "terminal-region",
        source: "tool-diagnostic",
        rect,
        confidence: CONFIDENCE_DIAGNOSTIC,
        priority: PRIORITY_DIAGNOSTIC,
        timestamp: performance.now(),
        reason: "diagnostic",
      });
    } else if (event.name === "stop") {
      attention.setSourceTarget("tool-running", null);
      attention.setSourceTarget("tool-diagnostic", null);
    }
  });

  return {
    dispose: () => {
      sub.dispose();
    },
  };
}

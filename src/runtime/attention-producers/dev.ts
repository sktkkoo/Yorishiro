/**
 * Dev attention producer。
 *
 * Ctrl/Meta+Shift+A の keydown で attention-debug sample target を
 * 一時 emit (priority=100、maxAge で自動失効)。production build では
 * `isDev: false` で no-op (window listener も付かない)。
 */

import type { AttentionRuntime } from "../attention-runtime/types";
import type { Disposable } from "./types";

const PRIORITY = 100;
const SAMPLE_RECT = { x: 100, y: 100, width: 80, height: 40 };

interface StartOptions {
  readonly attention: AttentionRuntime;
  readonly isDev: boolean;
}

export function startDevAttentionProducer(opts: StartOptions): Disposable {
  if (!opts.isDev) {
    return { dispose: () => {} };
  }
  const { attention } = opts;

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.shiftKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      attention.setSourceTarget("attention-debug", {
        kind: "mouse",
        source: "attention-debug",
        rect: SAMPLE_RECT,
        confidence: 1,
        priority: PRIORITY,
        timestamp: performance.now(),
        reason: "smoke-test",
      });
    }
  };

  window.addEventListener("keydown", onKeyDown, true);

  return {
    dispose: () => {
      window.removeEventListener("keydown", onKeyDown, true);
    },
  };
}

/**
 * Dev attention producer。
 *
 * Ctrl/Meta+Shift+A の keydown で attention-debug sample target を
 * 一時 emit (priority=100、maxAge で自動失効)。production build では
 * `isDev: false` で no-op (window listener も付かない)。
 *
 * また DEV モードでは attention runtime を subscribe し、snapshot 変化を
 * console に流す (`[attention] active {...}` / `[attention] cleared`)。
 * 同一 target が連続して来た場合は dedup し、毎フレームの重複 log を防ぐ。
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

  // === smoke-test: Ctrl/Meta+Shift+A で attention-debug target を emit ===
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

  // === DEV log: snapshot 変化を console に流す ===
  // dedup key は v1 (App.tsx) と同形式：source:kind:reason:priority(×100 rounded)
  let lastLoggedKey: string | null = null;
  const sub = attention.subscribe((snapshot) => {
    const target = snapshot.target;
    const key =
      target === null
        ? "null"
        : `${target.source}:${target.kind}:${target.reason ?? "none"}:${Math.round(target.priority * 100)}`;
    if (key === lastLoggedKey) return;
    lastLoggedKey = key;
    if (target === null) {
      // biome-ignore lint/suspicious/noConsole: dev-mode diagnostic
      console.info("[attention] cleared");
      return;
    }
    // biome-ignore lint/suspicious/noConsole: dev-mode diagnostic
    console.info("[attention] active", {
      source: target.source,
      kind: target.kind,
      reason: target.reason,
      priority: target.priority,
      confidence: target.confidence,
      rect: target.rect,
    });
  });

  return {
    dispose: () => {
      window.removeEventListener("keydown", onKeyDown, true);
      sub.dispose();
    },
  };
}

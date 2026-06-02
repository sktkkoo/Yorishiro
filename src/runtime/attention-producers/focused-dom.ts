/**
 * Focused-DOM attention producer。
 *
 * document.activeElement を監視し、xterm canvas / body 以外に focus が
 * 当たっている時 attention target として emit。priority 5 / kind: focused-dom。
 *
 * v1 App.tsx の rAF loop 内 focused-dom ロジックを producer 層に切り出したもの。
 * source key / priority / confidence / kind / reason は v1 と 1:1。
 *
 * スキップ条件（emit しないケース）:
 * - activeElement が null
 * - activeElement が <body> または <html>（デフォルトフォーカス）
 * - activeElement が terminal 系コンテナ配下（.terminal-container / .xterm-singleton-container / .xterm）
 * - bounding rect の width または height が 0（非表示 / 未レンダリング）
 *
 * v1 では rAF loop で毎 frame poll していたが、focused DOM の矩形は
 * 高頻度に変わらないため rAF に同期した低頻度 poll にする。
 */

import type { AttentionRuntime } from "../attention-runtime/types";
import type { Disposable } from "./types";

const SOURCE = "focused-dom";
const PRIORITY = 5;
const CONFIDENCE = 0.7;
const EXPAND_PX = 10;
export const FOCUSED_DOM_SCAN_INTERVAL_MS = 250;

interface StartOptions {
  readonly attention: AttentionRuntime;
  /** テスト用 rAF override。省略時は globalThis.requestAnimationFrame を使う。 */
  readonly raf?: (cb: FrameRequestCallback) => number;
  /** テスト用 cancelAnimationFrame override。省略時は globalThis.cancelAnimationFrame を使う。 */
  readonly cancelRaf?: (id: number) => void;
  /** テスト用 document.activeElement override。省略時は document.activeElement を直接参照。 */
  readonly getActiveElement?: () => Element | null;
}

export function startFocusedDomAttentionProducer(opts: StartOptions): Disposable {
  const {
    attention,
    raf = globalThis.requestAnimationFrame.bind(globalThis),
    cancelRaf = globalThis.cancelAnimationFrame.bind(globalThis),
    getActiveElement = () => document.activeElement,
  } = opts;

  let rafId: number | null = null;
  let focusActive = false;
  let lastScanAt = Number.NEGATIVE_INFINITY;
  let disposed = false;

  const scan = (): void => {
    const activeElement = getActiveElement();
    const htmlEl = activeElement instanceof HTMLElement ? activeElement : null;
    const activeRect = htmlEl?.getBoundingClientRect();

    const focusable =
      htmlEl !== null &&
      htmlEl !== document.body &&
      htmlEl !== document.documentElement &&
      !htmlEl.closest(".terminal-container") &&
      !htmlEl.closest(".xterm-singleton-container") &&
      !htmlEl.closest(".xterm") &&
      activeRect !== undefined &&
      activeRect.width > 0 &&
      activeRect.height > 0;

    if (focusable && activeRect !== undefined) {
      attention.setSourceTarget(SOURCE, {
        kind: "focused-dom",
        source: SOURCE,
        rect: {
          x: activeRect.left - EXPAND_PX,
          y: activeRect.top - EXPAND_PX,
          width: activeRect.width + EXPAND_PX * 2,
          height: activeRect.height + EXPAND_PX * 2,
        },
        confidence: CONFIDENCE,
        priority: PRIORITY,
        timestamp: performance.now(),
        reason: "focus",
      });
      focusActive = true;
    } else {
      if (focusActive) {
        attention.setSourceTarget(SOURCE, null);
        focusActive = false;
      }
    }
  };

  const tick = (now: DOMHighResTimeStamp): void => {
    if (disposed) return;
    if (now - lastScanAt >= FOCUSED_DOM_SCAN_INTERVAL_MS) {
      lastScanAt = now;
      scan();
    }
    rafId = raf(tick);
  };

  rafId = raf(tick);

  return {
    dispose: () => {
      disposed = true;
      if (rafId !== null) {
        cancelRaf(rafId);
        rafId = null;
      }
      if (focusActive) {
        attention.setSourceTarget(SOURCE, null);
        focusActive = false;
      }
    },
  };
}

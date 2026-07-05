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
 * 高頻度に変わらないため timer + one-shot rAF の低頻度 poll にする。
 */

import type { AttentionRuntime } from "../attention-runtime/types";
import type { Disposable } from "./types";

const SOURCE = "focused-dom";
const PRIORITY = 5;
const CONFIDENCE = 0.7;
const EXPAND_PX = 10;
export const FOCUSED_DOM_SCAN_INTERVAL_MS = 250;
/**
 * rect 不変でも timestamp を進めるための再 emit 間隔。
 * attention-resolver は kind 別 maxAge（focused-dom は 2000ms）で stale target を
 * 除外するため、dedup で emit を止めたままにすると focus 継続中に target が
 * stale 落ちして aura が消え、rect が変わるまで復帰しない。
 */
export const FOCUSED_DOM_KEEPALIVE_MS = 1000;

interface StartOptions {
  readonly attention: AttentionRuntime;
  /** テスト用 rAF override。省略時は globalThis.requestAnimationFrame を使う。 */
  readonly raf?: (cb: FrameRequestCallback) => number;
  /** テスト用 cancelAnimationFrame override。省略時は globalThis.cancelAnimationFrame を使う。 */
  readonly cancelRaf?: (id: number) => void;
  /** テスト用 document.activeElement override。省略時は document.activeElement を直接参照。 */
  readonly getActiveElement?: () => Element | null;
  /** scan loop 用 timer。省略時は globalThis.setTimeout。 */
  readonly setScanTimeout?: (fn: () => void, delay: number) => unknown;
  readonly clearScanTimeout?: (id: unknown) => void;
}

export function startFocusedDomAttentionProducer(opts: StartOptions): Disposable {
  const {
    attention,
    raf = globalThis.requestAnimationFrame.bind(globalThis),
    cancelRaf = globalThis.cancelAnimationFrame.bind(globalThis),
    getActiveElement = () => document.activeElement,
    setScanTimeout = globalThis.setTimeout.bind(globalThis),
    clearScanTimeout = globalThis.clearTimeout.bind(globalThis) as (id: unknown) => void,
  } = opts;

  let rafId: number | null = null;
  let scanTimer: unknown | null = null;
  let focusActive = false;
  let disposed = false;
  let lastX = Number.NaN;
  let lastY = Number.NaN;
  let lastWidth = Number.NaN;
  let lastHeight = Number.NaN;
  let lastEmitAt = Number.NEGATIVE_INFINITY;

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
      const x = activeRect.left - EXPAND_PX;
      const y = activeRect.top - EXPAND_PX;
      const width = activeRect.width + EXPAND_PX * 2;
      const height = activeRect.height + EXPAND_PX * 2;
      const now = performance.now();
      if (
        focusActive &&
        now - lastEmitAt < FOCUSED_DOM_KEEPALIVE_MS &&
        x === lastX &&
        y === lastY &&
        width === lastWidth &&
        height === lastHeight
      ) {
        return;
      }
      lastX = x;
      lastY = y;
      lastWidth = width;
      lastHeight = height;
      lastEmitAt = now;
      attention.setSourceTarget(SOURCE, {
        kind: "focused-dom",
        source: SOURCE,
        rect: {
          x,
          y,
          width,
          height,
        },
        confidence: CONFIDENCE,
        priority: PRIORITY,
        timestamp: now,
        reason: "focus",
      });
      focusActive = true;
    } else {
      if (focusActive) {
        attention.setSourceTarget(SOURCE, null);
        focusActive = false;
        lastX = Number.NaN;
        lastY = Number.NaN;
        lastWidth = Number.NaN;
        lastHeight = Number.NaN;
      }
    }
  };

  function scheduleScan(delay = FOCUSED_DOM_SCAN_INTERVAL_MS): void {
    if (disposed || scanTimer !== null) return;
    scanTimer = setScanTimeout(() => {
      scanTimer = null;
      if (disposed) return;
      rafId = raf(runScanFrame);
    }, delay);
  }

  function runScanFrame(): void {
    rafId = null;
    if (disposed) return;
    scan();
    scheduleScan();
  }

  scheduleScan(0);

  return {
    dispose: () => {
      disposed = true;
      if (rafId !== null) {
        cancelRaf(rafId);
        rafId = null;
      }
      if (scanTimer !== null) {
        clearScanTimeout(scanTimer);
        scanTimer = null;
      }
      if (focusActive) {
        attention.setSourceTarget(SOURCE, null);
        focusActive = false;
      }
      lastX = Number.NaN;
      lastY = Number.NaN;
      lastWidth = Number.NaN;
      lastHeight = Number.NaN;
    },
  };
}

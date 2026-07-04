/**
 * Input cursor attention producer。
 *
 * timer + one-shot rAF で caret 位置を poll し、stateful に管理:
 * - rect が取れた: input-cursor:typing として emit (priority=5)
 * - rect 不在 (null) かつ前回 active: null clear
 * - rect 不在 かつ前回 inactive: 何もしない
 *
 * scan 時だけ rAF に同期して getInputCursorClientPosition を呼ぶことで、
 * user 入力時に lastUserInputAt が更新されたことを自然に拾う
 * （subscribePtyData は agent 出力でしか発火しないため使わない）。
 *
 * dispose で rAF cancel と active source clear を行う。
 */

import type { AttentionRuntime } from "../attention-runtime/types";
import type { TerminalRuntime } from "../terminal-runtime/types";
import type { Disposable } from "./types";

const SOURCE_TYPING = "input-cursor:typing";
const PRIORITY_TYPING = 5;
const CONFIDENCE = 1;
export const INPUT_CURSOR_SCAN_INTERVAL_MS = 1000 / 15;

interface StartOptions {
  readonly attention: AttentionRuntime;
  readonly terminal: Pick<TerminalRuntime, "getInputCursorClientPosition">;
  /** scan loop 用 timer。省略時は globalThis.setTimeout。 */
  readonly setScanTimeout?: (fn: () => void, delay: number) => unknown;
  readonly clearScanTimeout?: (id: unknown) => void;
}

export function startInputCursorAttentionProducer(opts: StartOptions): Disposable {
  const { attention, terminal } = opts;
  const setScanTimeoutFn: (fn: () => void, delay: number) => unknown =
    opts.setScanTimeout ?? globalThis.setTimeout.bind(globalThis);
  const clearScanTimeoutFn: (id: unknown) => void =
    opts.clearScanTimeout ?? (globalThis.clearTimeout.bind(globalThis) as (id: unknown) => void);
  let typingActive = false;
  let rafId: number | null = null;
  let scanTimer: unknown | null = null;
  let disposed = false;
  let lastX = Number.NaN;
  let lastY = Number.NaN;
  let lastWidth = Number.NaN;
  let lastHeight = Number.NaN;

  const updateTyping = (): void => {
    const cursor = terminal.getInputCursorClientPosition();
    if (cursor === null) {
      if (typingActive) {
        attention.setSourceTarget(SOURCE_TYPING, null);
        typingActive = false;
        lastX = Number.NaN;
        lastY = Number.NaN;
        lastWidth = Number.NaN;
        lastHeight = Number.NaN;
      }
      return;
    }
    const x = cursor.clientX;
    const y = cursor.clientY;
    const width = cursor.cellWidth;
    const height = cursor.cellHeight;
    if (
      typingActive &&
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
    attention.setSourceTarget(SOURCE_TYPING, {
      kind: "input-cursor",
      source: SOURCE_TYPING,
      rect: {
        x,
        y,
        width,
        height,
      },
      confidence: CONFIDENCE,
      priority: PRIORITY_TYPING,
      timestamp: performance.now(),
      reason: "typing",
    });
    typingActive = true;
  };

  // scan 時だけ rAF に同期して caret 位置を poll する（v1 同様）。
  // subscribePtyData は agent 出力でのみ発火するため user 入力を拾えない。
  function scheduleScan(delay = INPUT_CURSOR_SCAN_INTERVAL_MS): void {
    if (disposed || scanTimer !== null) return;
    scanTimer = setScanTimeoutFn(() => {
      scanTimer = null;
      if (disposed) return;
      rafId = requestAnimationFrame(runScanFrame);
    }, delay);
  }

  function runScanFrame(): void {
    rafId = null;
    if (disposed) return;
    updateTyping();
    scheduleScan();
  }

  scheduleScan(0);

  return {
    dispose: () => {
      disposed = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (scanTimer !== null) {
        clearScanTimeoutFn(scanTimer);
        scanTimer = null;
      }
      if (typingActive) {
        attention.setSourceTarget(SOURCE_TYPING, null);
        typingActive = false;
      }
      lastX = Number.NaN;
      lastY = Number.NaN;
      lastWidth = Number.NaN;
      lastHeight = Number.NaN;
    },
  };
}

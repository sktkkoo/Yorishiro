/**
 * Input cursor attention producer。
 *
 * rAF loop で毎 frame caret 位置を poll し、stateful に管理:
 * - rect が取れた: input-cursor:typing として emit (priority=5)
 * - rect 不在 (null) かつ前回 active: null clear
 * - rect 不在 かつ前回 inactive: 何もしない
 *
 * v1 と同様に getInputCursorClientPosition を rAF 毎に呼ぶことで、
 * user 入力時に lastUserInputAt が更新されたことを自然に拾う
 * （subscribePtyData は agent 出力でしか発火しないため使わない）。
 *
 * Enter keydown を listen し、focused 要素が <button> / <a> / [role=button] なら
 * input-cursor:activate、それ以外は input-cursor:sent を priority=5 で emit する。
 * どちらも 600ms 後に null clear する短いパルス設計（Enter は単発 event のため、
 * resolver maxAge 任せの定常監視原則と分けて producer 側で短い ttl を持つ例外）。
 * dispose で rAF cancel + pulse timer cancel を両方行う。
 */

import type { AttentionRuntime } from "../attention-runtime/types";
import type { TerminalRuntime } from "../terminal-runtime/types";
import type { Disposable } from "./types";

const SOURCE_TYPING = "input-cursor:typing";
const SOURCE_SENT = "input-cursor:sent";
const SOURCE_ACTIVATE = "input-cursor:activate";
const PRIORITY_TYPING = 5;
const PRIORITY_SENT_ACTIVATE = 5;
const CONFIDENCE = 1;
// Enter は単発 event のため、resolver maxAge 任せの定常監視原則と異なり、
// producer 側で 600ms 後に null clear する短いパルス設計。
const PULSE_CLEAR_MS = 600;

// Enter で activate される標準的な要素のみ。`<input type="submit">` 等は
// Charminal の terminal-first UI で現状想定外のため省略 (mouse producer の
// INTERACTIVE_TAGS は click 対象なので別集合)。Phase 1d 実 UI で要拡張なら追加。
const ACTIVATABLE_TAGS = new Set(["BUTTON", "A"]);

interface StartOptions {
  readonly attention: AttentionRuntime;
  readonly terminal: Pick<TerminalRuntime, "getInputCursorClientPosition">;
}

export function startInputCursorAttentionProducer(opts: StartOptions): Disposable {
  const { attention, terminal } = opts;
  let typingActive = false;
  let pulseTimer: ReturnType<typeof setTimeout> | null = null;
  let rafId: number | null = null;

  const cancelPulseTimer = (): void => {
    if (pulseTimer !== null) {
      clearTimeout(pulseTimer);
      pulseTimer = null;
    }
  };

  const updateTyping = (): void => {
    const cursor = terminal.getInputCursorClientPosition();
    if (cursor === null) {
      if (typingActive) {
        attention.setSourceTarget(SOURCE_TYPING, null);
        typingActive = false;
      }
      return;
    }
    attention.setSourceTarget(SOURCE_TYPING, {
      kind: "input-cursor",
      source: SOURCE_TYPING,
      rect: {
        x: cursor.clientX,
        y: cursor.clientY,
        width: cursor.cellWidth,
        height: cursor.cellHeight,
      },
      confidence: CONFIDENCE,
      priority: PRIORITY_TYPING,
      timestamp: performance.now(),
      reason: "typing",
    });
    typingActive = true;
  };

  // rAF loop で毎 frame caret 位置を poll する（v1 同様）。
  // subscribePtyData は agent 出力でのみ発火するため user 入力を拾えない。
  const tick = (): void => {
    updateTyping();
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Enter") return;
    // IME composition 中 (かな漢字変換の確定 Enter) は送信 Enter と区別して無視。
    if (event.isComposing) return;
    const focused = document.activeElement;
    let source: string;
    let rect: { x: number; y: number; width: number; height: number };
    let reason: string;

    if (
      focused instanceof HTMLElement &&
      (ACTIVATABLE_TAGS.has(focused.tagName) || focused.getAttribute("role") === "button")
    ) {
      const r = focused.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return; // jsdom 等で rect 0 はスキップ
      source = SOURCE_ACTIVATE;
      rect = { x: r.left, y: r.top, width: r.width, height: r.height };
      reason = "activate";
    } else {
      const cursor = terminal.getInputCursorClientPosition();
      if (cursor === null) return;
      source = SOURCE_SENT;
      rect = {
        x: cursor.clientX,
        y: cursor.clientY,
        width: cursor.cellWidth,
        height: cursor.cellHeight,
      };
      reason = "sent";
    }

    cancelPulseTimer();
    attention.setSourceTarget(source, {
      kind: "input-cursor",
      source,
      rect,
      confidence: CONFIDENCE,
      priority: PRIORITY_SENT_ACTIVATE,
      timestamp: performance.now(),
      reason,
    });
    pulseTimer = setTimeout(() => {
      attention.setSourceTarget(source, null);
      pulseTimer = null;
    }, PULSE_CLEAR_MS);
  };

  window.addEventListener("keydown", onKeyDown, true);

  return {
    dispose: () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener("keydown", onKeyDown, true);
      cancelPulseTimer();
    },
  };
}

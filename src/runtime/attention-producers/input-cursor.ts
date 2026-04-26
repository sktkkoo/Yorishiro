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
 * dispose で rAF cancel を行う。
 */

import type { AttentionRuntime } from "../attention-runtime/types";
import type { TerminalRuntime } from "../terminal-runtime/types";
import type { Disposable } from "./types";

const SOURCE_TYPING = "input-cursor:typing";
const PRIORITY_TYPING = 5;
const CONFIDENCE = 1;

interface StartOptions {
  readonly attention: AttentionRuntime;
  readonly terminal: Pick<TerminalRuntime, "getInputCursorClientPosition">;
}

export function startInputCursorAttentionProducer(opts: StartOptions): Disposable {
  const { attention, terminal } = opts;
  let typingActive = false;
  let rafId: number | null = null;

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

  return {
    dispose: () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    },
  };
}

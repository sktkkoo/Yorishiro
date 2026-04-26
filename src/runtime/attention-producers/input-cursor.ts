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
 * hook-signal `user-prompt-submit` を listen し、発火時点の caret 位置に
 * input-cursor:sent を priority=5 で emit する。600ms 後に null clear する
 * 短いパルス設計（単発 event のため resolver maxAge 任せでなく producer 側で ttl を持つ）。
 * キー入力判定は一切行わない（IME / Shift+Enter / paste 誤検知排除）。
 *
 * dispose で rAF cancel + hookSub dispose + pulse timer cancel を全て行う。
 */

import type { AttentionRuntime } from "../attention-runtime/types";
import type { TerminalRuntime } from "../terminal-runtime/types";
import type { Disposable } from "./types";

const SOURCE_TYPING = "input-cursor:typing";
const SOURCE_SENT = "input-cursor:sent";
const PRIORITY_TYPING = 5;
const PRIORITY_SENT = 5;
const CONFIDENCE = 1;
// 単発 event のため、resolver maxAge 任せの定常監視原則と異なり、
// producer 側で 600ms 後に null clear する短いパルス設計。
const PULSE_CLEAR_MS = 600;

interface StartOptions {
  readonly attention: AttentionRuntime;
  readonly terminal: Pick<TerminalRuntime, "getInputCursorClientPosition">;
  /** EventBus hook-signal を購読する adapter。App.tsx から inject する。 */
  readonly subscribeHookSignal: (handler: (event: { name: string }) => void) => Disposable;
}

export function startInputCursorAttentionProducer(opts: StartOptions): Disposable {
  const { attention, terminal, subscribeHookSignal } = opts;
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

  // hook-signal `user-prompt-submit` を listen し、caret 位置に sent pulse を emit する。
  // caret が null のとき（直近 2 秒以内に typing なし等）は emit しない。
  const hookSub = subscribeHookSignal((event) => {
    if (event.name !== "user-prompt-submit") return;
    const cursor = terminal.getInputCursorClientPosition();
    if (cursor === null) return;
    cancelPulseTimer();
    attention.setSourceTarget(SOURCE_SENT, {
      kind: "input-cursor",
      source: SOURCE_SENT,
      rect: {
        x: cursor.clientX,
        y: cursor.clientY,
        width: cursor.cellWidth,
        height: cursor.cellHeight,
      },
      confidence: CONFIDENCE,
      priority: PRIORITY_SENT,
      timestamp: performance.now(),
      reason: "sent",
    });
    pulseTimer = setTimeout(() => {
      attention.setSourceTarget(SOURCE_SENT, null);
      pulseTimer = null;
    }, PULSE_CLEAR_MS);
  });

  return {
    dispose: () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      hookSub.dispose();
      cancelPulseTimer();
    },
  };
}

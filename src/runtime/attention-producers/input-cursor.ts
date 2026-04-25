/**
 * Input cursor attention producer。
 *
 * v2 MVP では typing 中の caret rect だけを emit (priority=3、reason="typing")。
 * Enter による submit / button activate の分岐は Phase 1c で aura 体験を
 * 確認してから tune する。
 *
 * PTY data event を trigger に caret 位置を読み、stateful に管理:
 * - rect が取れた: input-cursor:typing として emit
 * - rect 不在 (null) かつ前回 active: null clear
 * - rect 不在 かつ前回 inactive: 何もしない
 */

import type { AttentionRuntime } from "../attention-runtime/types";
import type { TerminalRuntime } from "../terminal-runtime/types";
import type { Disposable } from "./types";

const SOURCE = "input-cursor:typing";
const PRIORITY_TYPING = 3;
const CONFIDENCE = 1;

interface StartOptions {
  readonly attention: AttentionRuntime;
  readonly terminal: Pick<TerminalRuntime, "subscribePtyData" | "getInputCursorClientPosition">;
}

export function startInputCursorAttentionProducer(opts: StartOptions): Disposable {
  const { attention, terminal } = opts;
  let active = false;

  const update = (): void => {
    const cursor = terminal.getInputCursorClientPosition();
    if (cursor === null) {
      if (active) {
        attention.setSourceTarget(SOURCE, null);
        active = false;
      }
      return;
    }
    attention.setSourceTarget(SOURCE, {
      kind: "input-cursor",
      source: SOURCE,
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
    active = true;
  };

  const sub = terminal.subscribePtyData(update);

  return {
    dispose: () => {
      sub.dispose();
    },
  };
}

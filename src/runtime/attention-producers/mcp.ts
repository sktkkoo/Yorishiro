/**
 * MCP attention producer。
 *
 * `mcp:tool-request` Tauri event を listen し、tool 起動を mcp-ui kind の
 * AttentionTarget として emit する。
 *
 * v1 App.tsx `setMcpRequestAttention` を producer 層に切り出したもの。
 * source key / priority / confidence / timeout / rect 戦略は v1 と 1:1。
 *
 * - source key: "mcp-tool-request"
 * - priority: 4 / confidence: 0.72 / kind: mcp-ui
 * - reason: set-ui-state → "tool-writing"、それ以外 → "tool-reading"
 * - TTL: 1200ms の setTimeout で手動 clear（resolver maxAge には任せない）
 * - rect: `.ui-pack-container:not(.ui-pack-container--ambient)` または
 *   `.shell-column`（"shell" surface = 全カラム）を getTargetRect injection で取得する
 *
 * listen factory は injectable: 本番では `@tauri-apps/api/event` の
 * `listen` を adapter で wrap して渡す。test では fake を渡す。
 */

import type { AttentionRuntime } from "../attention-runtime/types";
import type { Disposable } from "./types";

const SOURCE = "mcp-tool-request";
const PRIORITY = 4;
const CONFIDENCE = 0.72;
const TIMEOUT_MS = 1200;
const EXPAND_PX = 8;

type EventListener<P> = (payload: P) => void;
export type ListenFactory = <P>(eventName: string, handler: EventListener<P>) => Disposable;

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface StartOptions {
  readonly attention: AttentionRuntime;
  readonly listen: ListenFactory;
  /** tool 名から rect を返す。App.tsx 側で DOM 要素の getBoundingClientRect を wrap して注入。 */
  readonly getTargetRect: (tool: string) => Rect | null;
  /** テスト用タイマー override。省略時は window.setTimeout / clearTimeout を使う。 */
  readonly setTimeout?: (cb: () => void, ms: number) => number;
  readonly clearTimeout?: (id: number) => void;
}

export function startMcpAttentionProducer(opts: StartOptions): Disposable {
  const {
    attention,
    listen,
    getTargetRect,
    setTimeout: _setTimeout = (cb: () => void, ms: number) => window.setTimeout(cb, ms),
    clearTimeout: _clearTimeout = (id: number) => window.clearTimeout(id),
  } = opts;

  let clearTimer: number | null = null;

  const sub = listen<{ tool: string }>("mcp:tool-request", (payload) => {
    const rect = getTargetRect(payload.tool);
    if (rect === null) return;

    // 前の timer があれば cancel してから再スタート
    if (clearTimer !== null) {
      _clearTimeout(clearTimer);
      clearTimer = null;
    }

    attention.setSourceTarget(SOURCE, {
      kind: "mcp-ui",
      source: SOURCE,
      rect: {
        x: rect.x - EXPAND_PX,
        y: rect.y - EXPAND_PX,
        width: rect.width + EXPAND_PX * 2,
        height: rect.height + EXPAND_PX * 2,
      },
      confidence: CONFIDENCE,
      priority: PRIORITY,
      timestamp: performance.now(),
      reason: payload.tool === "set-ui-state" ? "tool-writing" : "tool-reading",
    });

    clearTimer = _setTimeout(() => {
      attention.setSourceTarget(SOURCE, null);
      clearTimer = null;
    }, TIMEOUT_MS);
  });

  return {
    dispose: () => {
      sub.dispose();
      if (clearTimer !== null) {
        _clearTimeout(clearTimer);
        clearTimer = null;
      }
    },
  };
}

/**
 * MCP attention producer。
 *
 * `mcp:tool-request` event を listen し、tool 起動を mcp-ui kind の
 * AttentionTarget として emit。失効は resolver の maxAge=2000ms に任せる
 * (v1 の hard-coded setTimeout は廃止)。
 *
 * listen factory は injectable: 本番では `@tauri-apps/api/event` の
 * `listen` を adapter で wrap して渡す (Phase 1d で App.tsx 配線)、
 * test では fake を渡す。
 *
 * rect は PLACEHOLDER_RECT で仮置き。Phase 1c で aura 体験を確認しながら
 * 実際の MCP UI の rect 提供経路を再考する (event payload 拡張が有力候補)。
 */

import type { AttentionRuntime } from "../attention-runtime/types";
import type { Disposable } from "./types";

const PRIORITY = 6;
const CONFIDENCE = 0.72;
const PLACEHOLDER_RECT = { x: 0, y: 0, width: 100, height: 30 };

type EventListener<P> = (payload: P) => void;
export type ListenFactory = <P>(eventName: string, handler: EventListener<P>) => Disposable;

interface StartOptions {
  readonly attention: AttentionRuntime;
  readonly listen: ListenFactory;
}

export function startMcpAttentionProducer(opts: StartOptions): Disposable {
  const { attention, listen } = opts;

  const sub = listen<{ tool: string }>("mcp:tool-request", (payload) => {
    attention.setSourceTarget("mcp-tool-request", {
      kind: "mcp-ui",
      source: "mcp-tool-request",
      rect: PLACEHOLDER_RECT,
      confidence: CONFIDENCE,
      priority: PRIORITY,
      timestamp: performance.now(),
      reason: payload.tool === "set-ui-state" ? "tool-writing" : "tool-reading",
    });
  });

  return {
    dispose: () => {
      sub.dispose();
    },
  };
}

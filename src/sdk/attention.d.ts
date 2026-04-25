/**
 * @charminal/sdk/attention
 *
 * Attention API の canonical 型。
 *
 * AttentionTarget は producer (`src/runtime/attention-producers/`) が emit し、
 * core resolver が priority * 1000 + confidence で 1 本に絞る。consumer
 * (ambient-ui pack 等) は AttentionAPI 経由で snapshot を読む。
 *
 * AttentionAPI は **read-only** (`get` + `subscribe`)。pack は attention を
 * 読めるが書けない。`setSourceTarget` は producer 専用 API として
 * `src/runtime/attention-runtime/types.ts` の AttentionRuntime interface に
 * 分離している（PTY observation-only と同型の境界、philosophy:
 * docs/philosophy/INHABITED_CHARACTER_INTERFACE.md「観察の境界」）。
 *
 * Internal design-record: 2026-04-25-attention-aura-v2-design.md
 * 「Surface / SDK 設計」section
 */

import type { Disposable } from "./context";

/** kind の列挙（v2 で focused-dom を削除した 4 種）。 */
export type AttentionTargetKind = "mouse" | "input-cursor" | "terminal-region" | "mcp-ui";

/** 画面上の矩形。getBoundingClientRect 形式（top-left origin、px）。 */
export interface AttentionRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 1 つの観察を表す target。
 *
 * - `source`: producer 名（同 producer の上書きを許す key）
 * - `priority`: score = priority * 1000 + confidence。priority 1 段差は
 *               confidence の差を必ず上回る weight
 * - `confidence`: tie 時の決定子 (0..1)
 * - `timestamp`: 観察時刻（resolver の maxAge による freshness 判定）
 * - `reason`: 同 kind 内の subtype（"diagnostic" / "file-link" / "tool-running" 等）
 */
export interface AttentionTarget {
  readonly kind: AttentionTargetKind;
  readonly source: string;
  readonly rect: AttentionRect;
  readonly confidence: number;
  readonly priority: number;
  readonly timestamp: number;
  readonly reason?: string;
}

/** 1 frame 分の attention 状態（resolver が 1 本に絞った結果）。 */
export interface AttentionSnapshot {
  readonly target: AttentionTarget | null;
}

/**
 * pack が attention を読むための read-only 界面。
 *
 * - subscribe は **immediate-fire**: subscribe 時に最新 snapshot を即時
 *   listener に渡す（subscribe-before-emit / -after-emit 両対応）
 * - listener は同期的に呼ばれる
 */
export interface AttentionAPI {
  get(): AttentionSnapshot;
  subscribe(listener: (snapshot: AttentionSnapshot) => void): Disposable;
}

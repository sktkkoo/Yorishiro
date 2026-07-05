/**
 * AttentionRuntime の internal interface。
 *
 * SDK の AttentionAPI (read-only) を extend し、producer 専用の
 * setSourceTarget を加えた形。consumer (pack 等) は AttentionAPI で受け取り、
 * producer (`src/runtime/attention-producers/`) と内部 wiring は
 * AttentionRuntime で受け取る。
 *
 * 型レベルで「pack には write 権限を渡さない」を保証する分離。
 *
 * Internal design-record: 2026-04-25-attention-aura-v2-design.md
 * 「Surface / SDK 設計」section
 */

import type { AttentionAPI, AttentionTarget, Disposable } from "@yorishiro/sdk";

export interface AttentionRuntime extends AttentionAPI {
  setSourceTarget(source: string, target: AttentionTarget | null): void;
}

export type { Disposable };

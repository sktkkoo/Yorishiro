/**
 * @yorishiro/sdk/ambient-ui-pack
 *
 * Ambient UI Pack の定義型（5 つ目の pack kind、v2 で追加）。
 * packs/ambient-ui/<id>/ui.tsx では `satisfies AmbientUiPackDefinition` を
 * 使って export default する。
 *
 * Ambient UI は primary UI を上書きしない overlay layer に出る pack。
 * attention aura のような observation の visual 表現を、layout / character /
 * voice 等を一切触らずに描画する。
 *
 * 型レベルで意図的に排除している field：
 * - layout.update    — ambient は primary layout を変えない
 * - character        — ambient は body を動かさない (amenity motion-free と同型)
 * - voice / space    — 同様
 * - setSourceTarget  — pack には attention の write 権限を渡さない
 *                      (observation-only の境界)
 *
 * ambientUiPackRegistry は **multi-active**: 複数 pack が同時に mount され
 * 重なる。`config.json` の `activeAmbientUi` で user が picks する想定
 * (feedback_single_active_config_picks の精神を multi-active に拡張)。
 * **注: `activeAmbientUi` は Phase 1b 以降で `config.ts` に追加予定**。Phase 1a
 * 時点では config からの control はまだ wire されていない。
 *
 * Internal design-record: 2026-04-25-attention-aura-v2-design.md
 * 「Surface / SDK 設計」section
 */

import type { AttentionAPI } from "./attention";
import type { Disposable } from "./context";

/**
 * Ambient UI pack の mount context。
 *
 * v2 MVP では `attention` のみ。Phase 2 で persona pack の auraAffinity を
 * 読む経路を追加するときに `getActivePersonaAffinity()` 等を生やす。
 */
export interface AmbientUiContext {
  readonly attention: AttentionAPI;
}

/** Ambient UI pack の manifest。kind は文字列上は "ambient-ui"。 */
export interface AmbientUiPackManifest {
  readonly $schema?: string;
  readonly id: string;
  readonly name?: string;
  readonly type: "ambient-ui";
  readonly version: string;
  readonly charminalVersion: string;
  readonly description?: string;
  readonly executionClass?: "declarative" | "isolated-js" | "trusted-main-thread-js";
  readonly artifact?: {
    readonly sha256: string;
    readonly sizeBytes: number;
  };
  readonly entry: string;
}

/**
 * Ambient UI pack の定義。
 *
 * mount は container 内に自由に React component / 任意 DOM を描画する。
 * container は Charminal が `#ambient-layer` 内に作る pack ごとの独立 div。
 * z-index は pack 自身が style で決める（SDK doc 推奨: 100-999、toast 1000+）。
 *
 * mount は **同期的に** Disposable を返さなければならない。dispose で
 * RAF / event listener / DOM root を完全にクリーンアップする責任を負う
 * （hot-reload で 2 重描画を起こさないため）。
 */
export interface AmbientUiPackDefinition {
  readonly type: "ambient-ui";
  readonly id: string;
  readonly mount: (ctx: AmbientUiContext, container: HTMLDivElement) => Disposable;
}

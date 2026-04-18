// src/core/scene/types.ts

/**
 * Scene Compositor — 住人に「居る場所」を持たせる layer stack の型定義。
 *
 * Philosophy: docs/philosophy/CHARMINAL.md「住まうということ」
 * Internal design-record: specs/2026-04-18-scene-pack-compositor-design.md §4
 *
 * Phase 1 では hardcoded な stub scene で architecture を validate する。
 * Phase 2 で pack manifest loading、Phase 3 で ambient bindings を足す。
 */

/**
 * レイヤーの役割。compositor の挙動に影響するのはこの 3 種のみ。
 * role なしの layer は宣言順で積まれる（粒子、haze などに使う予定、Phase 2+）。
 */
export type LayerRole = "background" | "character" | "foreground";

/**
 * 1 枚の layer。MVP 最小 field セット。
 *
 * - `role`: compositor が特定の処理を効かせる対象
 *   （"character" role に children から VRM を差し込む）
 * - `backgroundColor` / `backgroundImage`: Phase 1 の stub 用。
 *   Phase 2 で `src: string`（asset path）に一本化する可能性あり
 * - `blur`: per-layer 独立の CSS filter blur 値（px）
 */
export interface Layer {
  readonly id: string;
  readonly role?: LayerRole;
  readonly backgroundColor?: string;
  readonly backgroundImage?: string; // CSS gradient or url(...)
  readonly blur?: number;
}

/**
 * scene の宣言。Phase 1 は layers だけ。
 * Phase 2 で `camera: CameraConfig`、Phase 3 で `ambient: AmbientBindings` を足す。
 */
export interface SceneSpec {
  readonly id: string;
  readonly layers: ReadonlyArray<Layer>;
}

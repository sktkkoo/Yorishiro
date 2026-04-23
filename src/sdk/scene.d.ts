/**
 * @charminal/sdk/scene
 *
 * Scene の data model。SceneCompositor / ScenePackRegistry / pack author が
 * 共有する canonical な型。
 *
 * Phase 1 で `src/core/scene/types.ts` に置いていたものを Phase 2 で SDK に
 * 移す（pack author が `import type { SceneSpec } from '@charminal/sdk'` で
 * 参照する public API になるため）。
 *
 * Internal design-record: specs/2026-04-18-scene-pack-compositor-design.md §4
 */

/**
 * レイヤーの役割。compositor の挙動に影響するのはこの 3 種のみ。
 * role なしの layer は宣言順で積まれる（粒子、haze などに使う）。
 */
export type LayerRole = "background" | "character" | "foreground";

/**
 * 1 枚の layer。
 *
 * - `role`: compositor が特定の処理を効かせる対象
 * - `src`: 画像 / 動画の path。拡張子から <img> or <video> を自動判定。
 *   pack-relative path（`"./assets/foo.mp4"`）または絶対 URL（`"https://..."`）。
 *   bundled / user どちらの pack でも書き方は共通、Loader が解決する
 * - `backgroundColor` / `backgroundImage`: CSS の単色 / gradient。src と併用可
 * - `blur`: per-layer 独立の CSS filter blur 値（px）
 */
export interface Layer {
  readonly id: string;
  readonly role?: LayerRole;
  readonly src?: string;
  readonly mediaType?: "image" | "video";
  readonly backgroundColor?: string;
  readonly backgroundImage?: string;
  readonly blur?: number;
}

/**
 * scene の宣言。
 *
 * - `layers` は先頭が一番奥、末尾が一番手前
 * - Phase 2 は layers のみ。Phase 3 で `ambient` binding、Phase 4+ で
 *   `camera` filter / Auto Color Correct を足す予定
 */
export interface SceneSpec {
  readonly id: string;
  readonly layers: ReadonlyArray<Layer>;
}

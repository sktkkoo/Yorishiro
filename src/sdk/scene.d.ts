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
 * Runtime が内蔵 renderer で描く procedural layer。
 *
 * Scene Pack 自体は declarative のまま保ち、Three.js などの実行コードは
 * Charminal runtime 側に閉じる。
 */
export type ProceduralLayerKind = "radiant-meadow";

export interface ProceduralLayer {
  readonly kind: ProceduralLayerKind;
}

/**
 * 1 枚の layer。
 *
 * - `role`: compositor が特定の処理を効かせる対象
 * - `src`: 画像 / 動画の path。拡張子から <img> or <video> を自動判定。
 *   pack-relative path（`"./assets/foo.mp4"`）または絶対 URL（`"https://..."`）。
 *   bundled / user どちらの pack でも書き方は共通、Loader が解決する
 * - `procedural`: runtime 内蔵の procedural renderer。src と併用しない
 * - `backgroundColor` / `backgroundImage`: CSS の単色 / gradient。src と併用可
 * - `blur`: per-layer 独立の CSS filter blur 値（px）
 */
export interface Layer {
  readonly id: string;
  readonly role?: LayerRole;
  readonly src?: string;
  readonly mediaType?: "image" | "video";
  readonly procedural?: ProceduralLayer;
  readonly backgroundColor?: string;
  readonly backgroundImage?: string;
  readonly blur?: number;
}

/**
 * Scene の ambient sound 宣言。常時 loop で鳴る atmospheric layer。
 *
 * - `src`: `'sound:<name>'` / `'sound:<namespace>/<name>'` (shared library)
 *          または `'./assets/<file>'` (pack-local)
 *          または絶対 URL (`https://...`)
 * - `volume`: 0..1。default 1.0
 *
 * Internal design-record: specs/2026-04-25-scene-ambient-audio-design.md §4.1
 */
export interface AmbientSound {
  readonly src: string;
  readonly volume?: number;
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
  /**
   * Default ambient mix。空配列 / undefined で無音 scene。
   * AmbientAudioRuntime が ScenePackRegistry を subscribe し、scene 切替 /
   * hot reload で 500ms crossfade を行う。共通 sound は再生位置を保持。
   *
   * Internal design-record: specs/2026-04-25-scene-ambient-audio-design.md §4
   */
  readonly ambient?: ReadonlyArray<AmbientSound>;
}

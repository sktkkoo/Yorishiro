/**
 * @charminal/sdk/scene-pack
 *
 * Scene Pack の定義型。
 * packs/scenes/<id>/scene.ts では `satisfies ScenePackDefinition` を使って
 * export default する。
 *
 * Scene Pack は declarative — event-driven の Effect Pack と異なり、pack の
 * 宣言が runtime 中ずっと画面を規定する存在。Registry が single-active で
 * 管理、active 変更が SceneCompositor に流れる。
 *
 * Internal design-record: specs/2026-04-18-scene-pack-registry.md §3
 */

import type { SceneSpec } from "./scene";

/**
 * scene pack の manifest.json が持つ field。
 *
 * Example:
 * ```json
 * {
 *   "$schema": "https://charminal.dev/schemas/pack-manifest.schema.json",
 *   "id": "simple-room",
 *   "name": "静かな部屋",
 *   "type": "scene",
 *   "version": "0.1.0",
 *   "charminalVersion": "^0.1.0",
 *   "description": "...",
 *   "entry": "scene.ts"
 * }
 * ```
 *
 * 注: `defaultActive` field は採用しない。Design B（memory:
 * feedback_single_active_config_picks）により、active 選択は pack 自己申告では
 * なく `~/.charminal/config.json` の `activeScene` で user が global に picks する。
 * factory default は App.tsx の bundled scene 登録。config が空なら Registry が
 * bundled の alphabetical 先頭（現状 `simple-room`）を fallback として選ぶ。
 */
export interface ScenePackManifest {
  readonly $schema?: string;
  readonly id: string;
  readonly name?: string;
  readonly type: "scene";
  readonly version: string;
  readonly charminalVersion: string;
  readonly description?: string;
  readonly entry: string;
}

/**
 * scene.ts の export default 型。
 *
 * Example:
 * ```typescript
 * import type { ScenePackDefinition } from '@charminal/sdk';
 *
 * export default {
 *   id: 'simple-room',
 *   type: 'scene',
 *   scene: {
 *     id: 'simple-room',
 *     layers: [
 *       { id: 'backdrop', role: 'background', backgroundImage: 'linear-gradient(...)', blur: 3 },
 *       { id: 'vrm-slot', role: 'character', blur: 0 },
 *     ],
 *   },
 * } satisfies ScenePackDefinition;
 * ```
 */
export interface ScenePackDefinition {
  readonly id: string;
  readonly type: "scene";
  readonly scene: SceneSpec;
}

/**
 * @yorishiro/sdk/scene-pack
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

import type { ComponentType, ReactNode } from "react";
import type { Disposable, Vec3 } from "./context";
import type { SceneSpec } from "./scene";

/**
 * scene pack の manifest.json が持つ field。
 *
 * Example:
 * ```json
 * {
 *   "$schema": "https://yorishiro.dev/schemas/pack-manifest.schema.json",
 *   "id": "simple-room",
 *   "name": "静かな部屋",
 *   "type": "scene",
 *   "version": "0.1.0",
 *   "yorishiroVersion": "^0.1.0",
 *   "description": "...",
 *   "entry": "scene.ts"
 * }
 * ```
 *
 * 注: `defaultActive` field は採用しない。Design B（memory:
 * feedback_single_active_config_picks）により、active 選択は pack 自己申告では
 * なく `~/.yorishiro/config.json` の `sceneByProject[projectRoot]`、なければ
 * global fallback の `activeScene` で user が picks する。factory default は
 * App.tsx の bundled scene 登録。config が空なら Registry が bundled の
 * alphabetical 先頭（現状 `simple-room`）を fallback として選ぶ。
 */
export interface ScenePackManifest {
  readonly $schema?: string;
  readonly id: string;
  readonly name?: string;
  readonly type: "scene";
  readonly version: string;
  readonly yorishiroVersion: string;
  readonly description?: string;
  readonly executionClass?: "declarative" | "isolated-js" | "trusted-main-thread-js";
  readonly artifact?: {
    readonly sha256: string;
    readonly sizeBytes: number;
  };
  readonly entry: string;
}

/**
 * Scene pack が R3F component を export する場合に受け取る props.
 *
 * - `vrmSlot`: VRM character の mount slot. 現状は runtime が `null` を渡す
 *   （VRM は ThreeRuntime が imperative に管理）. 将来 VRM が R3F tree に
 *   入った時点で `<VrmCharacter />` が渡されるようになる. Pack 作者は
 *   `vrmSlot` を任意位置に挿入してよく, null の時は no-op として扱う.
 * - `resolveAsset`: pack-relative path を絶対 URL に変換するヘルパー.
 *   Bundled / user 両 origin で書き方は統一される（"./assets/foo.glb"）.
 * - `controls`: 別 spec で扱う leva 連携用. 本 phase では型のみ provide,
 *   value source は未配線（runtime は常に undefined を渡す）.
 *
 * Internal design-record: specs/2026-05-03-scene-pack-r3f-component.md §3.1
 */
export interface ScenePackComponentProps {
  readonly vrmSlot: ReactNode;
  readonly resolveAsset: (relativePath: string) => string;
  readonly controls?: Record<string, unknown>;

  /**
   * Camera modulation API. Scene pack が VRM 追従 camera に additive な
   * 微小変調（breath / drift / sway）を加えるための interface.
   *
   * 変調は base position への相対 offset として適用される.
   * MCP / UI pack が camera claim を取得している間は変調の適用が自動 suspend.
   * Pack unmount 時に全 modulation は自動解除される.
   *
   * Internal design-record: specs/2026-05-03-scene-pack-camera-api.md
   */
  readonly camera: ScenePackCameraAPI;
}

/**
 * Scene pack が camera に continuous modulation を加えるための API.
 * Base camera 制御（position/target/fov の absolute 設定）は Common controls
 * (`controls_set` / `controls_transition`) が担う.
 * 本 API は base に対する additive な微小変調のみを扱う.
 */
export interface ScenePackCameraAPI {
  /** Position offset modulation を登録する. 毎フレーム evaluate → base に加算. */
  addPositionModulation(
    key: string,
    evaluate: (elapsed: number, delta: number) => Vec3,
  ): Disposable;

  /** FOV offset modulation を登録する. 毎フレーム evaluate → base FOV に加算. */
  addFovModulation(key: string, evaluate: (elapsed: number, delta: number) => number): Disposable;

  /** 全 modulation を解除. Pack unmount 時に runtime が自動呼出し. */
  clearAll(): void;

  /** Claim により modulation が suspend 中か（観察用, read-only）. */
  readonly isSuspended: boolean;
}

/**
 * scene.ts の export default 型。
 *
 * Example:
 * ```typescript
 * import type { ScenePackDefinition } from '@yorishiro/sdk';
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

  /**
   * Optional R3F component による visual 表現.
   * 提供されれば runtime が R3F host に mount する.
   * scene.layers も併用でき, component + layers の hybrid scene として扱われる.
   * 提供されなければ既存の SceneCompositor が scene.layers を DOM stack で描画.
   *
   * bundled pack / user pack のどちらでも提供できる.
   * user pack では scene.tsx entry を使うと React + three.js の component を書ける.
   *
   * Internal design-record: specs/2026-05-03-scene-pack-r3f-component.md §3.1, §5.2
   */
  readonly component?: ComponentType<ScenePackComponentProps>;
}

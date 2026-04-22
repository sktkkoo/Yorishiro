/**
 * @charminal/sdk/ui-pack
 *
 * UI Pack の定義型（5 つ目の pack kind）。
 * packs/ui/<id>/ui.tsx では `satisfies UiPackDefinition` を使って export default する。
 *
 * UI Pack は Charminal の UI を丸ごと定義する single-active pack。
 * `config.json` の `activeUi` で user が picks する（feedback_single_active_config_picks）。
 * layout spec で固定要素（terminal / sidebar / character）の配置を宣言し、
 * mount で container 内に自由に React component を描画する。
 *
 * UiContext は Plan 3 で three / claim / state を追加済み。Plan 4 の
 * user UI pack .tsx transpile までは読み込み経路が限定的なため、early adopter
 * の pack 作者は小さな追加変更への追従を想定すること。
 *
 * Internal design-record: specs/2026-04-21-ui-pack-design.md
 */

import type { VRM } from "@pixiv/three-vrm";
import type * as THREE from "three";
import type { CharacterAPI, Disposable, LogAPI, SpaceAPI, Time } from "./context";

/**
 * Charminal の layout を UI pack がどう変えるかの宣言。
 * 未指定フィールドは default のまま（非破壊的）。
 *
 * UiLayoutAPI.update は **full-replace semantics**：
 *   毎回 resetLayout を呼んでから partial を full layout として apply する。
 *   前回 apply した値は残らない。
 */
export interface UiLayout {
  readonly sidebar?: {
    /** "default" = 280px, "fullscreen" = 100vw, "hidden" = 0, number = px 指定 */
    readonly width?: "default" | "fullscreen" | "hidden" | number;
    /** sidebar の配置。"overlay" は terminal の上に重なる */
    readonly position?: "left" | "right" | "overlay";
    /** 背景透過 */
    readonly transparent?: boolean;
  };
  readonly terminal?: {
    /** "default" = flex:1、"bottom" = 画面下 40% に配置、"hidden" = display:none、object = 絶対配置 */
    readonly position?:
      | "default"
      | "bottom"
      | "hidden"
      | {
          readonly top: string;
          readonly left: string;
          readonly width: string;
          readonly height: string;
        };
  };
  readonly character?: {
    /** false にすると Three.js canvas を非表示 */
    readonly visible?: boolean;
  };
}

export interface UiPackManifest {
  readonly $schema?: string;
  readonly id: string;
  readonly name?: string;
  readonly type: "ui";
  readonly version: string;
  readonly charminalVersion: string;
  readonly description?: string;
  readonly entry: string;
}

/**
 * UI pack の mount context（Plan 3 時点の shape）。
 *
 * - space: existing SpaceAPI（injectEffect 等）を再利用
 * - character: existing CharacterAPI（express / play / gaze）を再利用
 * - three: Three.js オブジェクトを直接操作（camera / scene / renderer / vrm）
 * - claim: 本体の自動処理を一時 suspend（camera tracking / expression / animation）
 * - state: MCP bridge と共有する key-value state
 * - layout: runtime で layout を変更する API
 * - signal: pack deactivate 時に fire する AbortSignal
 */
export interface UiContext {
  readonly space: SpaceAPI;
  readonly character: CharacterAPI;
  readonly three: UiThreeAPI;
  readonly claim: UiClaimAPI;
  readonly state: UiStateAPI;
  readonly time: Time;
  readonly log: LogAPI;
  readonly signal: AbortSignal;
  readonly layout: UiLayoutAPI;
}

/**
 * Three.js オブジェクトへの live 参照。pack は `.position.set(...)` のように
 * 直接 mutate してよい。ただし「本体の自動処理と衝突するもの」（camera tracking、
 * 呼吸、表情）は `ctx.claim.xxx()` で本体の更新を止めてから触ること。
 *
 * vrm は load 前は null、load 後に非 null。現状 vrm 入れ替えは想定しない。
 */
export interface UiThreeAPI {
  readonly camera: THREE.PerspectiveCamera;
  readonly scene: THREE.Scene;
  readonly renderer: THREE.WebGLRenderer;
  readonly vrm: VRM | null;
}

/**
 * 本体の自動処理を suspend する claim API。
 *
 * 各 method は Disposable を返し、dispose で release する。UI pack が
 * deactivate される（signal abort）と、pack 内の Disposable は一斉に
 * dispose される責務を pack 作者が持つ。万が一漏れても App.tsx の
 * cleanup path で強制 release される（safety net）。
 *
 * 対象：
 *   - camera: ThreeRuntime の head tracking（`camera.position.y` 追従 + `lookAt`）
 *   - expression: Body の express slot 解決 + VRM expressionManager への反映
 *   - animation: Body の animationPlayer.update + proceduralBones.update（呼吸 / head drift / VRMA）
 *
 * ※ lighting は Plan 2 時点では hard-code のため claim 対象外。scene 経由で直接操作する。
 */
export interface UiClaimAPI {
  camera(): Disposable;
  expression(): Disposable;
  animation(): Disposable;
}

/**
 * UI pack と Claude Code（MCP）をつなぐ key-value state。
 *
 * この API は active UI pack ごとに scope される。pack A の `camera.x` と
 * pack B の `camera.x` は別値として保持される。MCP からは packId 省略時に
 * active UI pack の state を read/write する。
 *
 * value は JSON serializable な値を推奨する。runtime は unknown として保持し、
 * MCP 経由では JSON として read/write される。
 */
export interface UiStateAPI {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  subscribe(key: string, listener: (value: unknown) => void): Disposable;
}

export interface UiLayoutAPI {
  /**
   * layout を full-replace する（reset → apply）。差分適用ではない：
   * 引数 `full` は「今適用したい layout の完全な形」であり、前回 apply した値は残らない。
   */
  update(full: UiLayout): void;
}

/**
 * ui.tsx の export default 型。
 *
 * mount は React 等で container を描画し、Disposable を返す。
 * dispose は pack deactivate 時（signal abort 直後）に呼ばれ、React root の
 * unmount / 子 Disposable の解放を行う責務を持つ。
 */
export interface UiPackDefinition {
  readonly id: string;
  readonly type: "ui";
  readonly layout: UiLayout;
  readonly mount: (ctx: UiContext, container: HTMLDivElement) => Disposable;
}

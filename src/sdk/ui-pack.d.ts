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
 * ⚠️ UiContext は Plan 3 完了まで unstable。現在の shape（space / character /
 * time / log / signal / layout）は Plan 2 で three / claim が追加され、
 * Plan 3 で state が追加される予定。early adopter の pack 作者は追従を想定すること。
 *
 * Internal design-record: specs/2026-04-21-ui-pack-design.md
 */

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
    /** "default" = flex:1、"hidden" = display:none、object = 絶対配置 */
    readonly position?:
      | "default"
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
 * UI pack の mount context（Plan 1 時点の shape）。
 *
 * ⚠️ unstable: Plan 2 で three / claim、Plan 3 で state が追加される。
 *
 * - space: existing SpaceAPI（injectEffect 等）を再利用
 * - character: existing CharacterAPI（express / play / gaze）を再利用
 * - layout: runtime で layout を変更する API
 * - signal: pack deactivate 時に fire する AbortSignal
 */
export interface UiContext {
  readonly space: SpaceAPI;
  readonly character: CharacterAPI;
  readonly time: Time;
  readonly log: LogAPI;
  readonly signal: AbortSignal;
  readonly layout: UiLayoutAPI;
}

export interface UiLayoutAPI {
  /** 現在の layout を full-replace する（reset → apply）。差分適用ではない。 */
  update(layout: UiLayout): void;
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

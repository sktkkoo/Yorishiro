/**
 * immersive — terminal を半透明で前面に全画面配置し、背後に character と scene が透ける没入モード。
 *
 * 【構成】
 * - sidebar を fullscreen に広げ、shell-column（character + scene）を全画面バックドロップにする。
 *   position:"overlay" / transparent:true は使わない——scene/character を背景として
 *   "見せたい" ため、不透明な shell-column の背後を透かす必要はない。
 * - terminal を固定配置（position オブジェクト）で全画面に展開し、
 *   opacity 0.6 で半透明にする。これにより terminal 越しに背後の character / scene が透けて見える。
 * - chrome（folder/gear 行）を非表示。
 * - mount は何も描画せず空の Disposable を返す。
 *   前バージョンの ctx.scene.updateLayer / resetAll による scene 抑制は撤去——
 *   scene は抑制せずバックドロップとして活かす。
 *
 * 【前バージョンとの対比】
 * 旧: sidebar overlay + transparent + scene layer 抑制 → キャラを terminal の上に浮かせ、terminal が背後に透けた
 * 新: sidebar fullscreen（バックドロップ）+ terminal 前面・半透明 → terminal 越しにキャラ/scene が透ける
 *
 * terminal を完全に消したい場合は theater pack。
 * terminal opacity の実値は MCP `ui.terminal.set {opacity}` でライブ調整可能（対称）。
 * Internal design-record: specs/2026-05-18-shell-named-surfaces-design.md §5-P3
 */

import type { Disposable, UiContext, UiPackDefinition } from "@charminal/sdk";

const immersive: UiPackDefinition = {
  id: "immersive",
  type: "ui",
  layout: {
    // shell-column（character + scene）を全画面バックドロップとして展開する。
    // overlay / transparent は使わない——scene を不透明に描画したいため。
    sidebar: { width: "fullscreen" },
    // folder / gear 行を非表示。
    chrome: { visible: false },
    // terminal を画面全体に固定配置し、opacity 0.6 で半透明にする。
    // これにより terminal 越しに背後の character + scene が透ける。
    // opacity の実値はライブ調整前提（MCP controls_transition / ui.terminal.set で変更可能）。
    terminal: {
      position: { top: "0", left: "0", width: "100vw", height: "100vh" },
      opacity: 0.6,
    },
  },
  mount(_ctx: UiContext, _container: HTMLDivElement): Disposable {
    // container には何も描画しない。layout 宣言だけで構成が完結する。
    // scene の updateLayer / resetAll は呼ばない——バックドロップとして活かすため。
    return { dispose() {} };
  },
};

export default immersive;

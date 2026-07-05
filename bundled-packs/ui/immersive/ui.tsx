/**
 * immersive — terminal を全画面前面に置きつつ背景のみ透明化し、背後に character と scene が鮮明に透ける没入モード。
 *
 * 【構成】
 * - sidebar を fullscreen に広げ、shell-column（character + scene）を全画面バックドロップにする。
 *   position:"overlay" / transparent:true は使わない——scene/character を背景として
 *   "見せたい" ため、不透明な shell-column の背後を透かす必要はない。
 * - terminal を固定配置（position オブジェクト）で全画面に展開し、
 *   transparentBackground で「背景のみ」透明化する。文字は前景色で不透明のまま読めるので、
 *   背後の character + scene が鮮明に見えつつ terminal の出力も完全に判読できる。
 * - chrome（folder/gear 行）を非表示。
 * - mount は何も描画せず空の Disposable を返す。
 *   前バージョンの ctx.scene.updateLayer / resetAll による scene 抑制は撤去——
 *   scene は抑制せずバックドロップとして活かす。
 *
 * 【前バージョンとの対比】
 * 旧: sidebar overlay + transparent + scene layer 抑制 → キャラを terminal の上に浮かせ、terminal が背後に透けた
 * 中: sidebar fullscreen + terminal element opacity → terminal 全体（文字含む）が半透明化し文字が読みづらかった
 * 新: sidebar fullscreen + terminal transparentBackground → 背景だけ透け、文字は不透明のまま読める
 *
 * terminal を完全に消したい場合は theater pack。
 * Internal design-record: specs/2026-05-18-shell-named-surfaces-design.md §5-P3
 */

import type { Disposable, UiContext, UiPackDefinition } from "@yorishiro/sdk";

const immersive: UiPackDefinition = {
  id: "immersive",
  type: "ui",
  layout: {
    // shell-column（character + scene）を全画面バックドロップとして展開する。
    // overlay / transparent は使わない——scene を不透明に描画したいため。
    sidebar: { width: "fullscreen" },
    // folder / gear 行を非表示。
    chrome: { visible: false },
    // terminal を（常設タイトルバーの下の）作業域いっぱいに固定配置し、背景のみ透明化する
    // （element opacity 版から移行）。文字は不透明のまま読め、背後の character + scene が鮮明に透ける。
    // top/height にタイトルバー高さ(--title-bar-height)を織り込むのは、terminal がタイトルバーへ
    // はみ出してサイドバートグル等のボタンを覆い隠さないようにするため。
    terminal: {
      position: {
        top: "var(--title-bar-height)",
        left: "0",
        width: "100vw",
        height: "calc(100vh - var(--title-bar-height))",
      },
      transparentBackground: true,
    },
  },
  mount(_ctx: UiContext, _container: HTMLDivElement): Disposable {
    // container には何も描画しない。layout 宣言だけで構成が完結する。
    // scene の updateLayer / resetAll は呼ばない——バックドロップとして活かすため。
    return { dispose() {} };
  },
};

export default immersive;

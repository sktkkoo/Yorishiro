/**
 * immersive — chrome（folder/gear）を隠し、キャラを全画面化する UI pack。
 * terminal は宣言しない＝背後に残り、作業をうっすら感じながらキャラが画面を占有する。
 * （住人が画面に "宿る" ICI 的な presence モード）
 * Internal design-record: specs/2026-05-18-shell-named-surfaces-design.md §5-P3
 */

import type { Disposable, UiPackDefinition } from "@charminal/sdk";

const immersive: UiPackDefinition = {
  id: "immersive",
  type: "ui",
  layout: {
    sidebar: { width: "fullscreen" },
    chrome: { visible: false },
  },
  mount(_ctx, _container): Disposable {
    return { dispose() {} };
  },
};

export default immersive;

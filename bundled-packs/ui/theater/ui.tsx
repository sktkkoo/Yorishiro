/**
 * theater — chrome と terminal を隠し、キャラだけを全画面化する UI pack。
 * 作業面を完全に退け、住人だけが画面に在る。
 * Internal design-record: specs/2026-05-18-shell-named-surfaces-design.md §5-P3
 */

import type { Disposable, UiPackDefinition } from "@charminal/sdk";

const theater: UiPackDefinition = {
  id: "theater",
  type: "ui",
  layout: {
    sidebar: { width: "fullscreen" },
    terminal: { position: "hidden" },
    chrome: { visible: false },
  },
  mount(_ctx, _container): Disposable {
    return { dispose() {} };
  },
};

export default theater;

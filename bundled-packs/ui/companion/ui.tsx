/**
 * companion — 他の作業の横に置く、細い常時手前表示の住人 UI pack。
 * terminal / chrome / tab indicator を隠し、native window の最小幅を下げる。
 */

import type { Disposable, UiPackDefinition } from "@yorishiro/sdk";

const companion: UiPackDefinition = {
  id: "companion",
  type: "ui",
  layout: {
    window: {
      width: 320,
      height: 720,
      minWidth: 320,
      minHeight: 420,
      alwaysOnTop: true,
    },
    sidebar: { width: "fullscreen" },
    terminal: { position: "hidden" },
    chrome: { visible: false },
    tabIndicator: { visible: false },
  },
  mount(_ctx, _container): Disposable {
    return { dispose() {} };
  },
};

export default companion;

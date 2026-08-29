import type { Disposable, UiPackDefinition } from "@yorishiro/sdk";

const portrait: UiPackDefinition = {
  id: "portrait",
  type: "ui",
  layout: {
    window: {
      width: 200,
      height: 300,
      minWidth: 200,
      minHeight: 300,
      alwaysOnTop: true,
      aspectRatio: 2 / 3,
    },
    sidebar: { width: "fullscreen" },
    terminal: { position: "hidden" },
    chrome: { visible: false },
    tabIndicator: { visible: false },
  },
  mount(): Disposable {
    return { dispose() {} };
  },
};
export default portrait;

/**
 * minimal-badge — Plan 1 の動作確認用 dummy UI pack。
 *
 * layout は default のまま（sidebar / terminal / character は一切変更しない）。
 * container（document.body 直下の overlay div）の右上に半透明バッジを 1 つ置く。
 * クリックで ctx.space.injectEffect("screen-shake") を発火する（単独で動作検証できる
 * ように既存 bundled effect を使う）。
 *
 * pointer-events: 親 container は pointer-events: none（Charminal 本体の決定）。
 * バッジ側で pointer-events: auto を明示的に書く必要がある（継承しないため）。
 */

import type { UiContext, UiPackDefinition } from "@charminal/sdk";
import type React from "react";
import ReactDOM from "react-dom/client";

function Badge({ ctx }: { ctx: UiContext }): React.JSX.Element {
  return (
    <button
      type="button"
      style={{
        position: "absolute",
        top: "12px",
        right: "12px",
        padding: "6px 12px",
        background: "rgba(36, 52, 71, 0.85)",
        color: "#eceff4",
        border: "1px solid rgba(77, 217, 207, 0.4)",
        borderRadius: "8px",
        fontSize: "11px",
        fontFamily: "monospace",
        pointerEvents: "auto",
        cursor: "pointer",
        userSelect: "none",
        backdropFilter: "blur(6px)",
      }}
      onClick={() => {
        ctx.space.injectEffect({
          kind: "screen-shake",
          intensity: 0.3,
          durationMs: 400,
        });
      }}
    >
      UI pack: minimal-badge
    </button>
  );
}

export default {
  id: "minimal-badge",
  type: "ui",
  layout: {},
  mount(ctx, container) {
    const root = ReactDOM.createRoot(container);
    root.render(<Badge ctx={ctx} />);
    return {
      dispose: () => {
        root.unmount();
      },
    };
  },
} satisfies UiPackDefinition;

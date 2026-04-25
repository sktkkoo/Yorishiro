/**
 * charminal-settings — Charminal の設定画面 bundled UI pack。
 *
 * activeUi を一時 swap して開閉する。閉じる時は直前の activeUi を ui-state-store
 * から取って setActiveUi で復元する（実際の setActiveUi 呼び出しは App.tsx 側で
 * `charminal-settings:close-requested` CustomEvent を listen して実行する）。
 *
 * Internal design-record: specs/2026-04-25-settings-screen-design.md
 */

import type { Disposable, UiContext, UiPackDefinition } from "@charminal/sdk";
import type React from "react";
import ReactDOM from "react-dom/client";

export const SETTINGS_PACK_ID = "charminal-settings";
export const PREVIOUS_ACTIVE_UI_KEY = "previous-active-ui";

export interface ResolveCloseTargetArgs {
  readonly saved: string | null;
  readonly availableIds: readonly string[];
}

/**
 * 閉じる時に setActiveUi へ渡す id を計算する（App.tsx 側 listener が使う pure helper）。
 * - saved が null → null
 * - saved が settings 自身（init.js 誤設定）→ null
 * - saved が現在の registry に居ない（hot reload 等で消えた）→ null
 */
export function resolveCloseTarget(args: ResolveCloseTargetArgs): string | null {
  if (args.saved === null) return null;
  if (args.saved === SETTINGS_PACK_ID) return null;
  if (!args.availableIds.includes(args.saved)) return null;
  return args.saved;
}

function Panel({ ctx }: { ctx: UiContext }): React.JSX.Element {
  const onClose = () => {
    const saved = ctx.state.get(PREVIOUS_ACTIVE_UI_KEY);
    const savedStr = typeof saved === "string" ? saved : null;
    // self-id（init.js 誤設定）の場合は null 化。registry 不在 id は App.tsx 側 listener で fallback。
    const target = savedStr === SETTINGS_PACK_ID ? null : savedStr;
    window.dispatchEvent(
      new CustomEvent("charminal-settings:close-requested", {
        detail: { target },
      }),
    );
  };

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: "var(--sidebar-width)",
        width: "calc(100% - var(--sidebar-width))",
        height: "100vh",
        background: "rgba(14, 23, 34, 0.96)",
        color: "#eceff4",
        fontFamily: "monospace",
        fontSize: "12px",
        pointerEvents: "auto",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          padding: "16px 20px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span style={{ fontSize: "14px", fontWeight: 600 }}>設定</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="設定を閉じる"
          style={{
            cursor: "pointer",
            opacity: 0.8,
            padding: "4px 10px",
            borderRadius: "4px",
            background: "rgba(255,255,255,0.06)",
            color: "inherit",
            border: "none",
            font: "inherit",
          }}
        >
          ✕
        </button>
      </header>
      <main style={{ flex: 1, padding: "20px", overflowY: "auto" }}>
        <p style={{ opacity: 0.6 }}>section A / B / C は次の Task で追加します。</p>
      </main>
      <footer
        style={{
          padding: "12px 20px",
          borderTop: "1px solid rgba(255,255,255,0.08)",
          fontSize: "11px",
          opacity: 0.55,
        }}
      >
        ⌘R / Ctrl+R で Charminal 全体を reload できます
      </footer>
    </div>
  );
}

const settingsPack: UiPackDefinition = {
  id: SETTINGS_PACK_ID,
  type: "ui",
  layout: {
    sidebar: {},
    terminal: { position: "hidden" },
    character: { visible: true },
  },
  mount(ctx, container): Disposable {
    const root = ReactDOM.createRoot(container);
    root.render(<Panel ctx={ctx} />);
    return {
      dispose: () => {
        root.unmount();
      },
    };
  },
};

export default settingsPack;

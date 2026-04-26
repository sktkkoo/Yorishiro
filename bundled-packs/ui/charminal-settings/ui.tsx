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
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { ptyWrite } from "../../../src/bindings/tauri-commands";
import { TerminalPromptButton } from "../../../src/sdk/components/terminal-prompt-button";

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

export interface ApplyConfigUpdateArgs<T> {
  readonly next: T;
  readonly prev: T;
  readonly setLocal: (value: T) => void;
  readonly write: (value: T) => Promise<void>;
  readonly emitEvent: (name: string, payload?: unknown) => void;
  readonly field: string;
}

/**
 * 楽観的 update + 失敗時 rollback + emitEvent。設定 dropdown / toggle 共通の handler。
 */
export async function applyConfigUpdate<T>(args: ApplyConfigUpdateArgs<T>): Promise<void> {
  args.setLocal(args.next);
  try {
    await args.write(args.next);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[charminal-settings] ${args.field} write failed:`, reason);
    args.emitEvent("charminal-settings:write-failed", { field: args.field, reason });
    args.setLocal(args.prev);
  }
}

function Panel({ ctx }: { ctx: UiContext }): React.JSX.Element {
  const [vrmName, setVrmName] = useState<string>(() => {
    const stored = localStorage.getItem("charminal:vrm");
    return stored ? (stored.split("/").pop() ?? stored) : "";
  });
  const [persona, setPersona] = useState<string | null>(null);
  const [scene, setScene] = useState<string | null>(null);
  const [agent, setAgent] = useState<"claude" | "codex">("claude");
  const personas = ctx.app.listPersonas();
  const scenes = ctx.app.listScenes();

  useEffect(() => {
    let aborted = false;
    void ctx.app.getConfig().then((cur) => {
      if (aborted) return;
      setPersona(cur.primaryPersona);
      setScene(cur.activeScene);
      setAgent(cur.terminalAgent);
    });
    return () => {
      aborted = true;
    };
  }, [ctx]);

  const onPersonaChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    void applyConfigUpdate({
      next: e.target.value || null,
      prev: persona,
      setLocal: setPersona,
      write: (v) => ctx.app.setPrimaryPersona(v),
      emitEvent: (n, p) => ctx.emitEvent(n, p),
      field: "primaryPersona",
    });
  };

  const onSceneChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    void applyConfigUpdate({
      next: e.target.value || null,
      prev: scene,
      setLocal: setScene,
      write: (v) => ctx.app.setActiveScene(v),
      emitEvent: (n, p) => ctx.emitEvent(n, p),
      field: "activeScene",
    });
  };

  const onAgentChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value as "claude" | "codex";
    void applyConfigUpdate({
      next,
      prev: agent,
      setLocal: setAgent,
      write: (v) => ctx.app.setTerminalAgent(v),
      emitEvent: (n, p) => ctx.emitEvent(n, p),
      field: "terminalAgent",
    });
  };

  const onPickVrm = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { invoke } = await import("@tauri-apps/api/core");
      const selected = await open({
        title: "VRM ファイルを選択",
        filters: [{ name: "VRM", extensions: ["vrm"] }],
      });
      if (!selected) return;
      const dest = await invoke<string>("import_vrm", { src: selected as string });
      ctx.app.setVrm(dest);
      setVrmName(dest.split("/").pop() ?? dest);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error("[charminal-settings] vrm load failed:", reason);
      ctx.emitEvent("charminal-settings:write-failed", { field: "vrm", reason });
    }
  };

  const onClose = () => {
    const saved = ctx.state.get(PREVIOUS_ACTIVE_UI_KEY);
    const savedStr = typeof saved === "string" ? saved : null;
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
        <Section title="キャラクター">
          <Field label="VRM body">
            <div style={{ display: "flex", gap: "8px" }}>
              <div
                style={{
                  flex: "0 1 auto",
                  maxWidth: "200px",
                  background: "rgba(255,255,255,0.04)",
                  padding: "6px 10px",
                  borderRadius: "4px",
                  border: "1px solid rgba(255,255,255,0.08)",
                  opacity: 0.85,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={vrmName}
              >
                {vrmName || "（未読み込み）"}
              </div>
              <button
                type="button"
                onClick={onPickVrm}
                style={{
                  background: "rgba(255,255,255,0.08)",
                  color: "inherit",
                  border: "1px solid rgba(255,255,255,0.14)",
                  borderRadius: "4px",
                  padding: "6px 12px",
                  cursor: "pointer",
                  font: "inherit",
                }}
              >
                変更...
              </button>
            </div>
          </Field>
          <Field label="Persona">
            <select value={persona ?? ""} onChange={onPersonaChange} style={selectStyle}>
              <option value="">（選択しない）</option>
              {personas.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name ?? p.id} {p.origin === "user" ? "(user)" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Scene">
            <select value={scene ?? ""} onChange={onSceneChange} style={selectStyle}>
              <option value="">（選択しない）</option>
              {scenes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name ?? s.id} {s.origin === "user" ? "(user)" : ""}
                </option>
              ))}
            </select>
          </Field>
        </Section>
        <Section title="ターミナル">
          <Field label="Coding agent">
            <select value={agent} onChange={onAgentChange} style={selectStyle}>
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          </Field>
        </Section>
        <div
          style={{
            marginTop: "-20px",
            marginBottom: "28px",
            marginLeft: "112px",
            fontSize: "11px",
            opacity: 0.5,
          }}
        >
          ※ 次の terminal 起動から反映
        </div>
        <section style={{ marginBottom: "28px" }}>
          <div style={sectionLabelStyle}>ショートカット</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <TerminalPromptButton
              text="/charminal:charm ショートカットを変更したい"
              label="ショートカットを変更"
              closeActiveUiBeforeWrite
              ptyWrite={ptyWrite}
              closeActiveUi={() => {
                // close-requested イベントを fire（App.tsx 側 listener が setActiveUi で復元する）
                const saved = ctx.state.get(PREVIOUS_ACTIVE_UI_KEY);
                const target =
                  typeof saved === "string" && saved !== SETTINGS_PACK_ID ? saved : null;
                window.dispatchEvent(
                  new CustomEvent("charminal-settings:close-requested", {
                    detail: { target },
                  }),
                );
              }}
              onError={(reason) => {
                ctx.emitEvent("charminal-settings:write-failed", {
                  field: "shortcut-prompt",
                  reason,
                });
              }}
              style={{
                alignSelf: "flex-start",
                background: "rgba(77, 217, 207, 0.08)",
                color: "inherit",
                padding: "8px 14px",
                borderRadius: "4px",
                border: "1px solid rgba(77, 217, 207, 0.25)",
                cursor: "pointer",
                font: "inherit",
              }}
            />
            <div style={{ fontSize: "11px", opacity: 0.55, lineHeight: 1.5 }}>
              クリックで terminal に{" "}
              <code
                style={{
                  background: "rgba(255,255,255,0.06)",
                  padding: "1px 6px",
                  borderRadius: "3px",
                }}
              >
                /charminal:charm ショートカットを変更したい
              </code>{" "}
              を入力します。Enter で実行。
            </div>
          </div>
        </section>
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

const sectionLabelStyle: React.CSSProperties = {
  fontSize: "11px",
  opacity: 0.6,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  marginBottom: "12px",
};

const fieldGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "100px 1fr",
  gap: "8px 12px",
  alignItems: "center",
};

const selectStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: "4px",
  padding: "6px 10px",
  font: "inherit",
};

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section style={{ marginBottom: "28px" }}>
      <div style={sectionLabelStyle}>{title}</div>
      <div style={fieldGridStyle}>{children}</div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <>
      <div style={{ opacity: 0.7 }}>{label}</div>
      <div>{children}</div>
    </>
  );
}

const settingsPack: UiPackDefinition = {
  id: SETTINGS_PACK_ID,
  type: "ui",
  layout: {
    sidebar: {},
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

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
import { COLORS, FONT, RADIUS, SPACING } from "./tokens";

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

interface SelectOption {
  readonly value: string;
  readonly label: string;
}

/**
 * `appearance: none` + カスタム chevron SVG を持つ select component。
 * tokens 経由でスタイルを一元管理する。
 */
function Select({
  value,
  options,
  onChange,
  loadingPlaceholder,
}: {
  value: string;
  options: readonly SelectOption[];
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  /** value === "" の時に表示する disabled option（読み込み中など）。 */
  loadingPlaceholder?: string;
}): React.JSX.Element {
  return (
    <div style={{ position: "relative", display: "block", width: "100%" }}>
      <select
        value={value}
        onChange={onChange}
        style={{
          appearance: "none",
          WebkitAppearance: "none",
          MozAppearance: "none",
          background: COLORS.bgInput,
          border: `1px solid ${COLORS.borderSubtle}`,
          borderRadius: RADIUS.sm,
          padding: `${SPACING.sm} ${SPACING.xl} ${SPACING.sm} ${SPACING.md}`,
          color: COLORS.fg,
          font: "inherit",
          fontFamily: FONT.family,
          fontSize: FONT.sizeS,
          cursor: "pointer",
          width: "100%",
          outline: "none",
        }}
      >
        {value === "" && loadingPlaceholder && (
          <option value="" disabled>
            {loadingPlaceholder}
          </option>
        )}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <svg
        width="10"
        height="10"
        viewBox="0 0 12 12"
        aria-hidden="true"
        style={{
          position: "absolute",
          right: SPACING.sm,
          top: "50%",
          transform: "translateY(-50%)",
          pointerEvents: "none",
          color: COLORS.fgDimmer,
        }}
      >
        <path
          d="M2 4 L6 8 L10 4"
          stroke="currentColor"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

interface ButtonProps {
  readonly variant?: "primary" | "neutral";
  readonly onClick?: () => void;
  readonly children: React.ReactNode;
  readonly ariaLabel?: string;
  readonly style?: React.CSSProperties;
  readonly disabled?: boolean;
}

/**
 * 2 variant の汎用ボタン。
 * - primary: teal accent（accent soft fill + accent border）
 * - neutral: white-wash（bgButton fill + borderMid border）
 *
 * tokens 経由でスタイルを一元管理する。
 */
function Button(props: ButtonProps): React.JSX.Element {
  const variant = props.variant ?? "neutral";
  const variantStyle: React.CSSProperties =
    variant === "primary"
      ? {
          background: COLORS.accentSoft,
          border: `1px solid ${COLORS.accentBorder}`,
        }
      : {
          background: COLORS.bgButton,
          border: `1px solid ${COLORS.borderMid}`,
        };
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-label={props.ariaLabel}
      disabled={props.disabled}
      style={{
        ...variantStyle,
        color: COLORS.fg,
        borderRadius: RADIUS.sm,
        padding: `${SPACING.sm} ${SPACING.md}`,
        cursor: "pointer",
        font: "inherit",
        fontFamily: FONT.family,
        fontSize: FONT.sizeS,
        ...props.style,
      }}
    >
      {props.children}
    </button>
  );
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
        background: COLORS.bgPanel,
        color: COLORS.fg,
        fontFamily: FONT.family,
        fontSize: FONT.sizeS,
        pointerEvents: "auto",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          padding: `${SPACING.lg} ${SPACING.xl}`,
          borderBottom: `1px solid ${COLORS.borderSubtle}`,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span style={{ fontSize: FONT.sizeL, fontWeight: FONT.weightSemibold }}>設定</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="設定を閉じる"
          style={{
            cursor: "pointer",
            opacity: 0.8,
            padding: `${SPACING.xs} 10px`,
            borderRadius: RADIUS.sm,
            background: COLORS.bgInputHover,
            color: "inherit",
            border: "none",
            font: "inherit",
          }}
        >
          ✕
        </button>
      </header>
      <main style={{ flex: 1, padding: SPACING.xl, overflowY: "auto" }}>
        <Section title="キャラクター">
          <Field label="VRM body">
            <div style={{ display: "flex", gap: SPACING.sm }}>
              <div
                style={{
                  flex: "0 1 auto",
                  maxWidth: "200px",
                  background: COLORS.bgInput,
                  padding: `6px 10px`,
                  borderRadius: RADIUS.sm,
                  border: `1px solid ${COLORS.borderSubtle}`,
                  opacity: 0.85,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={vrmName}
              >
                {vrmName || "（未読み込み）"}
              </div>
              <Button onClick={onPickVrm}>変更...</Button>
            </div>
          </Field>
          <Field label="Persona">
            <Select
              value={persona ?? ""}
              onChange={onPersonaChange}
              loadingPlaceholder={persona === null ? "読み込み中..." : undefined}
              options={personas.map((p) => ({
                value: p.id,
                label: `${p.name ?? p.id}${p.origin === "user" ? " (user)" : ""}`,
              }))}
            />
          </Field>
          <Field label="Scene">
            <Select
              value={scene ?? ""}
              onChange={onSceneChange}
              loadingPlaceholder={scene === null ? "読み込み中..." : undefined}
              options={scenes.map((s) => ({
                value: s.id,
                label: `${s.name ?? s.id}${s.origin === "user" ? " (user)" : ""}`,
              }))}
            />
          </Field>
        </Section>
        <Section title="ターミナル">
          <Field label="Coding agent">
            <Select
              value={agent}
              onChange={onAgentChange}
              options={[
                { value: "claude", label: "Claude Code" },
                { value: "codex", label: "Codex" },
              ]}
            />
          </Field>
        </Section>
        <div
          style={{
            marginTop: `-${SPACING.xl}`,
            marginBottom: SPACING.xxl,
            marginLeft: "112px",
            fontSize: FONT.sizeXs,
            opacity: 0.5,
          }}
        >
          ※ 次の terminal 起動から反映
        </div>
        <section style={{ marginBottom: SPACING.xxl }}>
          <div style={sectionLabelStyle}>ショートカット</div>
          <div style={{ display: "flex", flexDirection: "column", gap: SPACING.sm }}>
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
                background: COLORS.accentSoft,
                color: COLORS.fg,
                padding: `${SPACING.sm} ${SPACING.lg}`,
                borderRadius: RADIUS.sm,
                border: `1px solid ${COLORS.accentBorder}`,
                cursor: "pointer",
                font: "inherit",
                fontFamily: FONT.family,
                fontSize: FONT.sizeS,
              }}
            />
            <div style={{ fontSize: FONT.sizeXs, opacity: 0.55, lineHeight: 1.5 }}>
              クリックで terminal に{" "}
              <code
                style={{
                  background: COLORS.bgInputHover,
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
          padding: `${SPACING.md} ${SPACING.xl}`,
          borderTop: `1px solid ${COLORS.borderSubtle}`,
          fontSize: FONT.sizeXs,
          opacity: 0.55,
        }}
      >
        ⌘R / Ctrl+R で Charminal 全体を reload できます
      </footer>
    </div>
  );
}

const sectionLabelStyle: React.CSSProperties = {
  fontSize: FONT.sizeXs,
  opacity: 0.6,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  marginBottom: SPACING.md,
};

const fieldGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "100px 1fr",
  gap: `${SPACING.sm} ${SPACING.md}`,
  alignItems: "center",
};

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section style={{ marginBottom: SPACING.xxl }}>
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

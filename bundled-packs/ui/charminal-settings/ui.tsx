/**
 * charminal-settings — Charminal の設定画面 bundled UI pack。
 *
 * activeUi を一時 swap して開閉する。閉じる時は直前の activeUi を ui-state-store
 * から取って setActiveUi で復元する（実際の setActiveUi 呼び出しは App.tsx 側で
 * `charminal-settings:close-requested` CustomEvent を listen して実行する）。
 *
 * Internal design-record: specs/2026-04-25-settings-screen-design.md
 */

import type {
  AppLanguage,
  Disposable,
  ResolvedLanguage,
  UiContext,
  UiPackDefinition,
} from "@charminal/sdk";
import { ChevronDown, Volume2, VolumeX } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { ptyWrite } from "../../../src/bindings/tauri-commands";
import { getStrings } from "../../../src/i18n/strings";
import {
  isBundledClaiPersonaId,
  localizedClaiPersonaId,
} from "../../../src/runtime/user-pack-loader/config";
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

function formatPackOptionLabel(pack: {
  readonly id: string;
  readonly name?: string;
  readonly origin: "bundled" | "user";
}): string {
  const suffixes: string[] = [];
  if (pack.id === "clai") suffixes.push("legacy");
  if (pack.origin === "user") suffixes.push("user");
  return `${pack.name ?? pack.id}${suffixes.length > 0 ? ` (${suffixes.join(", ")})` : ""}`;
}

export function filterPersonaOptionsForLanguage<T extends { readonly id: string }>(
  personas: readonly T[],
  language: ResolvedLanguage,
): T[] {
  const claiId = localizedClaiPersonaId(language);
  return personas.filter((p) => !isBundledClaiPersonaId(p.id) || p.id === claiId);
}

export function resolvePersonaSelectValue(
  primaryPersona: string | null,
  language: ResolvedLanguage,
): string {
  return primaryPersona === null || isBundledClaiPersonaId(primaryPersona)
    ? localizedClaiPersonaId(language)
    : primaryPersona;
}

export function configPrimaryPersonaForSelection(id: string): string | null {
  return isBundledClaiPersonaId(id) ? null : id;
}

/**
 * `appearance: none` + カスタム chevron SVG を持つ select component。
 * tokens 経由でスタイルを一元管理する。
 *
 * - options が 0 件: 非インタラクティブな「（pack なし）」ラベルを表示。
 * - options が 1 件: dropdown にする意味がないので static label として表示。
 * - options が 2 件以上: 通常の native select を表示。
 */
function Select({
  value,
  options,
  onChange,
  loadingPlaceholder,
  emptyLabel = "(no packs)",
}: {
  value: string;
  options: readonly SelectOption[];
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  /** value === "" の時に表示する disabled option（読み込み中など）。 */
  loadingPlaceholder?: string;
  emptyLabel?: string;
}): React.JSX.Element {
  // 0 options: pack が登録されていない
  if (options.length === 0) {
    return (
      <div
        style={{
          background: COLORS.bgInput,
          border: `1px solid ${COLORS.borderSubtle}`,
          borderRadius: RADIUS.sm,
          padding: `${SPACING.sm} ${SPACING.md}`,
          color: COLORS.fgDimmer,
          font: "inherit",
          fontFamily: FONT.family,
          fontSize: FONT.sizeS,
          minWidth: "220px",
          maxWidth: "360px",
        }}
      >
        {emptyLabel}
      </div>
    );
  }

  // 1 option: dropdown にする意味がないので static label として表示
  if (options.length === 1) {
    const sole = options[0];
    return (
      <div
        style={{
          background: COLORS.bgInput,
          border: `1px solid ${COLORS.borderSubtle}`,
          borderRadius: RADIUS.sm,
          padding: `${SPACING.sm} ${SPACING.md}`,
          color: COLORS.fgDim,
          font: "inherit",
          fontFamily: FONT.family,
          fontSize: FONT.sizeS,
          minWidth: "220px",
          maxWidth: "360px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={sole.label}
      >
        {sole.label}
      </div>
    );
  }

  // 通常: native select with chevron
  return (
    <div
      style={{
        position: "relative",
        display: "block",
        width: "100%",
        minWidth: "220px",
        maxWidth: "360px",
      }}
    >
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
      <ChevronDown
        size={10}
        aria-hidden="true"
        style={{
          position: "absolute",
          right: SPACING.sm,
          top: "50%",
          transform: "translateY(-50%)",
          pointerEvents: "none",
          color: COLORS.fgDimmer,
        }}
      />
    </div>
  );
}

/**
 * 音量 / ミュート切り替えの icon toggle button。boolean state を画面上で
 * 直接切り替える用途。state ごとに icon と border 色を変え、現在状態が一目で
 * わかるようにする。
 */
function AudioMuteToggle({
  muted,
  disabled,
  onToggle,
  labels,
}: {
  muted: boolean;
  disabled?: boolean;
  onToggle: () => void;
  labels: { readonly mute: string; readonly unmute: string };
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={muted}
      aria-label={muted ? labels.unmute : labels.mute}
      title={muted ? labels.unmute : labels.mute}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "32px",
        height: "32px",
        background: muted ? COLORS.bgInput : COLORS.accentSoft,
        border: `1px solid ${muted ? COLORS.borderSubtle : COLORS.accentBorder}`,
        borderRadius: RADIUS.sm,
        color: muted ? COLORS.fgDimmer : COLORS.accent,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        padding: 0,
        font: "inherit",
      }}
    >
      {muted ? (
        <VolumeX size={18} strokeWidth={1.8} aria-hidden="true" />
      ) : (
        <Volume2 size={18} strokeWidth={1.8} aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * シンプルな CSS toggle switch（36x20px）。Aura など boolean 設定向け。
 */
function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      style={{
        width: "36px",
        height: "20px",
        borderRadius: "10px",
        border: `1px solid ${checked ? COLORS.accentBorder : COLORS.borderSubtle}`,
        background: checked ? COLORS.accentSoft : COLORS.bgInput,
        cursor: disabled ? "default" : "pointer",
        position: "relative",
        padding: 0,
        transition: "background 200ms ease, border-color 200ms ease",
      }}
    >
      <div
        style={{
          width: "14px",
          height: "14px",
          borderRadius: "50%",
          background: checked ? COLORS.accent : COLORS.fgDimmer,
          position: "absolute",
          top: "2px",
          left: checked ? "18px" : "2px",
          transition: "left 200ms ease, background 200ms ease",
        }}
      />
    </button>
  );
}

/** grid の label-value pair 用の共通 grid style。 */
const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "100px 1fr",
  gap: `${SPACING.sm} ${SPACING.md}`,
  alignItems: "center",
};

function Panel({ ctx }: { ctx: UiContext }): React.JSX.Element {
  const [vrmName, setVrmName] = useState<string>(() => {
    const stored = localStorage.getItem("charminal:vrm");
    return stored ? (stored.split("/").pop() ?? stored) : "";
  });
  const [persona, setPersona] = useState<string | null>(null);
  const [scene, setScene] = useState<string | null>(null);
  const [agent, setAgent] = useState<"claude" | "codex">("claude");
  // 環境音 mute は config が読まれるまで undecided。getConfig 後に boolean を入れる。
  const [ambientMuted, setAmbientMuted] = useState<boolean | null>(null);
  // 環境音ボリューム（0.0-1.0）。config 読み込み前は null。
  const [ambientVolume, setAmbientVolume] = useState<number | null>(null);
  // activeAmbientUi（Aura toggle 等の状態管理用）。
  const [activeAmbientUi, setActiveAmbientUiLocal] = useState<readonly string[]>([]);
  const [language, setLanguage] = useState<AppLanguage>("auto");
  const [resolvedLanguage, setResolvedLanguage] = useState<ResolvedLanguage>("en");
  const [configLoaded, setConfigLoaded] = useState(false);
  const personas = ctx.app.listPersonas();
  const visiblePersonas = filterPersonaOptionsForLanguage(personas, resolvedLanguage);
  const personaSelectValue = configLoaded
    ? resolvePersonaSelectValue(persona, resolvedLanguage)
    : "";
  const scenes = ctx.app.listScenes();
  const strings = getStrings(resolvedLanguage);

  useEffect(() => {
    let aborted = false;
    void ctx.app.getConfig().then((cur) => {
      if (aborted) return;
      setPersona(cur.primaryPersona);
      setScene(cur.activeScene);
      setAgent(cur.terminalAgent);
      setAmbientMuted(cur.ambientAudioMuted);
      setAmbientVolume(cur.ambientAudioVolume);
      setActiveAmbientUiLocal(cur.activeAmbientUi);
      setLanguage(cur.language);
      setResolvedLanguage(cur.resolvedLanguage);
      setConfigLoaded(true);
    });
    return () => {
      aborted = true;
    };
  }, [ctx]);

  const onPersonaChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = configPrimaryPersonaForSelection(e.target.value);
    void applyConfigUpdate({
      next,
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

  const onLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value as AppLanguage;
    void applyConfigUpdate({
      next,
      prev: language,
      setLocal: setLanguage,
      write: async (v) => {
        await ctx.app.setLanguage(v);
        const cur = await ctx.app.getConfig();
        setPersona(cur.primaryPersona);
        setResolvedLanguage(cur.resolvedLanguage);
      },
      emitEvent: (n, p) => ctx.emitEvent(n, p),
      field: "language",
    });
  };

  const onAmbientMutedToggle = () => {
    if (ambientMuted === null) return; // 初回 load 中は無視
    void applyConfigUpdate({
      next: !ambientMuted,
      prev: ambientMuted,
      setLocal: setAmbientMuted,
      write: (v) => ctx.app.setAmbientAudioMuted(v),
      emitEvent: (n, p) => ctx.emitEvent(n, p),
      field: "ambientAudioMuted",
    });
  };

  const auraEnabled = activeAmbientUi.includes("attention-aura");

  const onAuraToggle = () => {
    const nextIds = auraEnabled
      ? activeAmbientUi.filter((id) => id !== "attention-aura")
      : [...activeAmbientUi, "attention-aura"];
    void applyConfigUpdate({
      next: nextIds,
      prev: [...activeAmbientUi],
      setLocal: setActiveAmbientUiLocal,
      write: (ids) => ctx.app.setActiveAmbientUi(ids),
      emitEvent: (n, p) => ctx.emitEvent(n, p),
      field: "activeAmbientUi",
    });
  };

  const onVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = Number.parseFloat(e.target.value);
    if (ambientVolume === null) return;
    void applyConfigUpdate({
      next,
      prev: ambientVolume,
      setLocal: setAmbientVolume,
      write: (v) => ctx.app.setAmbientAudioVolume(v),
      emitEvent: (n, p) => ctx.emitEvent(n, p),
      field: "ambientAudioVolume",
    });
  };

  const onPickVrm = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { invoke } = await import("@tauri-apps/api/core");
      const selected = await open({
        title: strings.selectVrmFile,
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

  /** 設定パネルを閉じる共通 helper。 */
  const fireCloseRequest = () => {
    const saved = ctx.state.get(PREVIOUS_ACTIVE_UI_KEY);
    const savedStr = typeof saved === "string" ? saved : null;
    const target = savedStr === SETTINGS_PACK_ID ? null : savedStr;
    window.dispatchEvent(
      new CustomEvent("charminal-settings:close-requested", {
        detail: { target },
      }),
    );
  };

  const onClose = () => {
    fireCloseRequest();
  };

  /** Shortcut footer link: 設定を閉じて terminal に /charm:shortcut prompt を pre-fill する。 */
  const onShortcutClick = async () => {
    fireCloseRequest();
    try {
      await ptyWrite({ data: strings.shortcutPrompt });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      ctx.emitEvent("charminal-settings:write-failed", { field: "shortcut-prompt", reason });
    }
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
      {/* header: close button のみ、right-aligned、border なし */}
      <header
        style={{
          padding: `${SPACING.lg} ${SPACING.xl}`,
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={strings.closeSettings}
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

      <main
        style={{
          flex: 1,
          padding: `0 ${SPACING.xl} ${SPACING.xl}`,
          width: "100%",
          maxWidth: "560px",
          overflowY: "auto",
        }}
      >
        {/* グループ 1: VRM / Persona / Scene / Aura */}
        <div style={gridStyle}>
          {/* Language */}
          <div style={{ opacity: 0.7 }}>{strings.language}</div>
          <div>
            <Select
              value={language}
              onChange={onLanguageChange}
              options={[
                { value: "auto", label: strings.languageAuto },
                { value: "en", label: strings.languageEnglish },
                { value: "ja", label: strings.languageJapanese },
              ]}
            />
          </div>

          {/* VRM */}
          <div style={{ opacity: 0.7 }}>VRM</div>
          <button
            type="button"
            onClick={onPickVrm}
            style={{
              width: "100%",
              minWidth: "220px",
              maxWidth: "360px",
              background: COLORS.bgInput,
              padding: "6px 10px",
              borderRadius: RADIUS.sm,
              border: `1px solid ${COLORS.borderSubtle}`,
              opacity: 0.85,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              cursor: "pointer",
              color: COLORS.fg,
              font: "inherit",
              fontFamily: FONT.family,
              fontSize: FONT.sizeS,
              textAlign: "left",
            }}
            title={vrmName || undefined}
          >
            {vrmName || strings.notLoaded}
          </button>

          {/* Persona */}
          <div style={{ opacity: 0.7 }}>Persona</div>
          <div>
            <Select
              value={personaSelectValue}
              onChange={onPersonaChange}
              loadingPlaceholder={!configLoaded ? strings.loading : undefined}
              emptyLabel={strings.noPacks}
              options={visiblePersonas.map((p) => ({
                value: p.id,
                label: formatPackOptionLabel(p),
              }))}
            />
          </div>

          {/* Scene */}
          <div style={{ opacity: 0.7 }}>Scene</div>
          <div>
            <Select
              value={scene ?? ""}
              onChange={onSceneChange}
              loadingPlaceholder={scene === null ? strings.loading : undefined}
              emptyLabel={strings.noPacks}
              options={scenes.map((s) => ({
                value: s.id,
                label: `${s.name ?? s.id}${s.origin === "user" ? " (user)" : ""}`,
              }))}
            />
          </div>

          {/* Aura */}
          <div style={{ opacity: 0.7 }}>Aura</div>
          <div>
            <Toggle checked={auraEnabled} onChange={onAuraToggle} />
          </div>
        </div>

        {/* 24px gap */}
        <div style={{ height: "24px" }} />

        {/* グループ 2: Sound（mute icon + volume slider） */}
        <div style={gridStyle}>
          <div style={{ opacity: 0.7 }}>Sound</div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: SPACING.sm,
              width: "100%",
              minWidth: "220px",
              maxWidth: "360px",
            }}
          >
            <AudioMuteToggle
              muted={ambientMuted ?? false}
              disabled={ambientMuted === null}
              onToggle={onAmbientMutedToggle}
              labels={{ mute: strings.muteAmbient, unmute: strings.unmuteAmbient }}
            />
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={ambientVolume ?? 1}
              onChange={onVolumeChange}
              disabled={ambientVolume === null}
              aria-label={strings.ambientVolume}
              style={{
                flex: 1,
                height: "4px",
                appearance: "none",
                WebkitAppearance: "none",
                background: COLORS.borderSubtle,
                borderRadius: "2px",
                outline: "none",
                cursor: ambientVolume === null ? "default" : "pointer",
                accentColor: COLORS.accent,
              }}
            />
          </div>
        </div>

        {/* 24px gap */}
        <div style={{ height: "24px" }} />

        {/* グループ 3: Terminal */}
        <div style={gridStyle}>
          <div style={{ opacity: 0.7 }}>Terminal</div>
          <div>
            <Select
              value={agent}
              onChange={onAgentChange}
              options={[
                { value: "claude", label: "Claude Code" },
                { value: "codex", label: "Codex" },
              ]}
            />
          </div>
        </div>
        <div
          style={{
            marginTop: SPACING.xs,
            marginLeft: `calc(100px + ${SPACING.md})`,
            fontSize: FONT.sizeXs,
            opacity: 0.5,
          }}
        >
          {strings.terminalAppliesNextLaunch}
        </div>

        {/* 48px gap before footer links */}
        <div style={{ height: "48px" }} />

        {/* footer links: License / Shortcut */}
        <div
          style={{
            display: "flex",
            gap: SPACING.xl,
            fontSize: FONT.sizeXs,
            opacity: 0.5,
          }}
        >
          <span style={{ cursor: "default" }}>License</span>
          <button
            type="button"
            onClick={onShortcutClick}
            style={{
              background: "none",
              border: "none",
              color: "inherit",
              font: "inherit",
              fontSize: "inherit",
              cursor: "pointer",
              padding: 0,
              textDecoration: "underline",
              textDecorationColor: "currentColor",
              textUnderlineOffset: "2px",
              opacity: 1,
            }}
          >
            Shortcut
          </button>
        </div>
      </main>
    </div>
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

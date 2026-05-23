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
  FixedTerminalPromptKey,
  ResolvedLanguage,
  UiAppPackDiagnoseResponse,
  UiAppPackStatusEntry,
  UiContext,
  UiHealthReport,
  UiPackDefinition,
} from "@charminal/sdk";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  FolderOpen,
  Package,
  RefreshCw,
  Volume2,
  VolumeX,
  Wrench,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { getStrings, type UiStrings } from "../../../src/i18n/strings";
import {
  isBundledClaiPersonaId,
  localizedClaiPersonaId,
} from "../../../src/runtime/user-pack-loader/config";
import { COLORS, FONT, RADIUS, SPACING } from "./tokens";

export const SETTINGS_PACK_ID = "charminal-settings";
export const PREVIOUS_ACTIVE_UI_KEY = "previous-active-ui";

const QUICK_ACTION_KEYS: ReadonlyArray<{
  readonly key: FixedTerminalPromptKey;
  readonly stringKey: keyof UiStrings;
}> = [
  { key: "help", stringKey: "quickHelp" },
  { key: "tutorial", stringKey: "quickTutorial" },
  { key: "shortcut", stringKey: "quickShortcut" },
  { key: "create-pack", stringKey: "quickCreatePack" },
  { key: "pomodoro", stringKey: "quickPomodoro" },
];

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
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("charminal-settings:config-changed", {
          detail: { field: args.field },
        }),
      );
    }
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
  const suffix = pack.origin === "user" ? " (user)" : "";
  return `${pack.name ?? pack.id}${suffix}`;
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

export function packWorkbenchKey(pack: Pick<UiAppPackStatusEntry, "id" | "kind">): string {
  return `${pack.kind || "unknown"}:${pack.id}`;
}

export function selectWorkbenchPack(
  previous: string | null,
  packs: readonly UiAppPackStatusEntry[],
): string | null {
  const keys = new Set(packs.map(packWorkbenchKey));
  if (previous !== null && keys.has(previous)) return previous;
  const firstProblem = packs.find((pack) => pack.status !== "loaded");
  return firstProblem
    ? packWorkbenchKey(firstProblem)
    : (packs[0] && packWorkbenchKey(packs[0])) || null;
}

function sortPackStatuses(packs: readonly UiAppPackStatusEntry[]): UiAppPackStatusEntry[] {
  const statusRank = { failed: 0, disabled: 1, loaded: 2 } as const;
  const originRank = { user: 0, bundled: 1 } as const;
  return [...packs].sort((a, b) => {
    const byStatus = statusRank[a.status] - statusRank[b.status];
    if (byStatus !== 0) return byStatus;
    const byOrigin = originRank[a.origin] - originRank[b.origin];
    if (byOrigin !== 0) return byOrigin;
    return `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`);
  });
}

export function summarizePackDiagnosis(diagnosis: UiAppPackDiagnoseResponse): {
  readonly state: "healthy" | "warning" | "error";
  readonly title: string;
  readonly detail: string;
} {
  const error = diagnosis.diagnostics.find((item) => item.severity === "error");
  if (error !== undefined) {
    return {
      state: "error",
      title: "Pack needs attention",
      detail: error.message,
    };
  }

  const warning = diagnosis.diagnostics.find((item) => item.severity === "warning");
  if (warning !== undefined) {
    return {
      state: "warning",
      title: "Pack has warnings",
      detail: warning.message,
    };
  }

  return {
    state: "healthy",
    title: "Pack looks healthy",
    detail: diagnosis.diagnoses.some((item) => item.isActive)
      ? "The pack is loaded and active."
      : "The pack is loaded.",
  };
}

function PackDiagnosisSummary({
  diagnosis,
  strings,
}: {
  diagnosis: UiAppPackDiagnoseResponse;
  strings: UiStrings;
}) {
  const summary = summarizePackDiagnosis(diagnosis);
  const localizedTitle =
    summary.state === "error"
      ? strings.packNeedsAttention
      : summary.state === "warning"
        ? strings.packWarnings
        : strings.packHealthy;
  const iconColor =
    summary.state === "error"
      ? COLORS.statusError
      : summary.state === "warning"
        ? COLORS.statusWarning
        : COLORS.accent;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "18px minmax(0, 1fr)",
        gap: SPACING.sm,
        alignItems: "start",
        padding: `${SPACING.sm} 0`,
        borderTop: `1px solid ${COLORS.borderSubtle}`,
        borderBottom: `1px solid ${COLORS.borderSubtle}`,
      }}
    >
      {summary.state === "healthy" ? (
        <CheckCircle2 size={15} color={iconColor} aria-hidden="true" />
      ) : (
        <AlertTriangle size={15} color={iconColor} aria-hidden="true" />
      )}
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: FONT.sizeS,
            fontWeight: FONT.weightSemibold,
            color: summary.state === "error" ? COLORS.statusError : COLORS.fg,
          }}
        >
          {localizedTitle}
        </div>
        <div
          style={{
            marginTop: "2px",
            color: COLORS.fgDimmer,
            fontSize: FONT.sizeXs,
            lineHeight: 1.45,
          }}
        >
          {summary.detail}
        </div>
      </div>
    </div>
  );
}

function PackDiagnosticRow({ item }: { item: UiAppPackDiagnoseResponse["diagnostics"][number] }) {
  const color =
    item.severity === "error"
      ? COLORS.statusError
      : item.severity === "warning"
        ? COLORS.statusWarning
        : COLORS.fgDimmer;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "112px minmax(0, 1fr)",
        gap: SPACING.sm,
        alignItems: "baseline",
        color: COLORS.fgDim,
        fontSize: FONT.sizeXs,
        lineHeight: 1.45,
      }}
    >
      <span
        style={{
          minWidth: 0,
          padding: "1px 6px",
          borderRadius: RADIUS.sm,
          border: `1px solid ${COLORS.borderSubtle}`,
          color,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={item.code}
      >
        {item.code}
      </span>
      <span
        style={{
          minWidth: 0,
          color: item.severity === "error" ? COLORS.statusError : COLORS.fgDim,
        }}
      >
        {item.message}
      </span>
    </div>
  );
}

function PackRecommendationRow({ text }: { text: string }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "112px minmax(0, 1fr)",
        gap: SPACING.sm,
        fontSize: FONT.sizeXs,
        lineHeight: 1.45,
      }}
    >
      <span />
      <span style={{ minWidth: 0, color: COLORS.fgDimmer }}>{text}</span>
    </div>
  );
}

function trustLabel(origin: string, executionClass?: string): string {
  if (origin === "bundled") return "Bundled with Charminal";
  if (executionClass === "trusted-main-thread-js") return "Local trusted code";
  if (executionClass === "isolated-js") return "Isolated sandbox";
  if (executionClass === "declarative") return "Declarative (no code)";
  return "Local";
}

function PackMetadata({
  diagnosis,
  origin,
}: {
  diagnosis: UiAppPackDiagnoseResponse | null;
  origin: string;
}): React.JSX.Element | null {
  const manifest = diagnosis?.diagnoses[0]?.manifest;
  const description = manifest?.description;
  const author = manifest?.author;
  const execClass = manifest?.executionClass;
  const trust = trustLabel(origin, execClass);

  if (!description && !author && origin === "bundled") return null;

  return (
    <div
      style={{
        marginBottom: SPACING.sm,
        paddingBottom: SPACING.sm,
        borderBottom: `1px solid ${COLORS.borderSubtle}`,
        fontSize: FONT.sizeXs,
        lineHeight: 1.45,
      }}
    >
      {description && <div style={{ color: COLORS.fgDim, marginBottom: "3px" }}>{description}</div>}
      <div style={{ color: COLORS.fgDimmer }}>
        {author && <span>{author} · </span>}
        <span>{trust}</span>
      </div>
    </div>
  );
}

function PackStatusIndicator({ status }: { status: UiAppPackStatusEntry["status"] }) {
  if (status === "failed") {
    return <AlertTriangle size={12} color={COLORS.statusError} aria-hidden="true" />;
  }
  const color = status === "disabled" ? COLORS.fgDimmer : COLORS.accent;
  return (
    <span
      style={{
        display: "inline-block",
        width: "6px",
        height: "6px",
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
      }}
    />
  );
}

function PackToggle({
  pack,
  busy,
  onToggle,
}: {
  pack: UiAppPackStatusEntry;
  busy: boolean;
  onToggle: (action: "enable" | "disable") => void;
}) {
  if (pack.origin !== "user") return null;
  const enabled = pack.status !== "disabled";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={`${enabled ? "Disable" : "Enable"} pack ${pack.id}`}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(enabled ? "disable" : "enable");
      }}
      style={{
        width: "28px",
        height: "16px",
        borderRadius: "8px",
        border: `1px solid ${enabled ? COLORS.accentBorder : COLORS.borderSubtle}`,
        background: enabled ? COLORS.accentSoft : COLORS.bgInput,
        cursor: busy ? "default" : "pointer",
        position: "relative",
        padding: 0,
        flexShrink: 0,
        transition: "background 200ms ease, border-color 200ms ease",
      }}
    >
      <div
        style={{
          width: "10px",
          height: "10px",
          borderRadius: "50%",
          background: enabled ? COLORS.accent : COLORS.fgDimmer,
          position: "absolute",
          top: "2px",
          left: enabled ? "14px" : "2px",
          transition: "left 200ms ease, background 200ms ease",
        }}
      />
    </button>
  );
}

function groupPacksByKind(
  packs: readonly UiAppPackStatusEntry[],
): { kind: string; packs: UiAppPackStatusEntry[] }[] {
  const map = new Map<string, UiAppPackStatusEntry[]>();
  for (const pack of packs) {
    const kind = pack.kind || "other";
    const group = map.get(kind);
    if (group) group.push(pack);
    else map.set(kind, [pack]);
  }
  const kindOrder = ["persona", "scene", "effect", "ui", "ambient-ui", "amenity", "other"];
  return [...map.entries()]
    .sort(([a], [b]) => {
      const ai = kindOrder.indexOf(a);
      const bi = kindOrder.indexOf(b);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    })
    .map(([kind, packs]) => ({ kind, packs }));
}

function HealthStatusIcon({ status }: { status: "ok" | "warning" | "error" }) {
  if (status === "ok") return <CheckCircle2 size={14} color={COLORS.accent} aria-hidden="true" />;
  return (
    <AlertTriangle
      size={14}
      color={status === "warning" ? COLORS.statusWarning : COLORS.statusError}
      aria-hidden="true"
    />
  );
}

function HealthDiagnostics({
  ctx,
  strings,
}: {
  ctx: UiContext;
  strings: UiStrings;
}): React.JSX.Element {
  const [report, setReport] = useState<UiHealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await ctx.app.getHealthReport();
      setReport(next);
      if (next.summary === "error") setOpen(true);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      setError(reason);
      setOpen(true);
      ctx.emitEvent("charminal-settings:write-failed", { field: "health-report", reason });
    } finally {
      setLoading(false);
    }
  }, [ctx]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const summaryStatus = report?.summary ?? (error ? "error" : null);
  const title =
    summaryStatus === "error"
      ? strings.healthNeedsAttention
      : summaryStatus === "warning"
        ? strings.healthWarnings
        : strings.healthHealthy;
  const titleColor =
    summaryStatus === "error"
      ? COLORS.statusError
      : summaryStatus === "warning"
        ? COLORS.statusWarning
        : COLORS.fgDimmer;

  return (
    <section>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: SPACING.sm,
            opacity: 0.78,
            border: "none",
            background: "transparent",
            color: COLORS.fg,
            cursor: "pointer",
            font: "inherit",
            fontSize: "inherit",
            padding: 0,
          }}
        >
          <ChevronDown
            size={14}
            aria-hidden="true"
            style={{
              transform: open ? "rotate(0deg)" : "rotate(-90deg)",
              transition: "transform 0.15s ease",
            }}
          />
          {summaryStatus !== null && summaryStatus !== "ok" ? (
            <HealthStatusIcon status={summaryStatus} />
          ) : report ? (
            <CheckCircle2 size={14} color={COLORS.accent} aria-hidden="true" />
          ) : null}
          <span>{strings.labelHealth}</span>
          {summaryStatus !== null && (
            <span style={{ color: titleColor, fontSize: FONT.sizeXs }}>{title}</span>
          )}
        </button>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          aria-label="Refresh health"
          title="Refresh health"
          style={{
            width: "26px",
            height: "26px",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            borderRadius: RADIUS.sm,
            background: "transparent",
            color: COLORS.fgDimmer,
            cursor: loading ? "default" : "pointer",
            opacity: loading ? 0.4 : 0.7,
            padding: 0,
          }}
        >
          <RefreshCw size={13} aria-hidden="true" />
        </button>
      </div>

      {open && (
        <div
          style={{
            marginTop: SPACING.md,
            border: `1px solid ${COLORS.borderSubtle}`,
            borderRadius: RADIUS.md,
            overflow: "hidden",
            maxWidth: "520px",
            background: COLORS.bgInput,
          }}
        >
          {report === null ? (
            <div style={{ padding: SPACING.md, color: COLORS.fgDimmer, fontSize: FONT.sizeXs }}>
              {error ?? "Checking…"}
            </div>
          ) : (
            <>
              {report.items.map((item) => (
                <div
                  key={item.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "18px minmax(0, 1fr)",
                    gap: SPACING.sm,
                    padding: `${SPACING.sm} ${SPACING.md}`,
                    borderBottom: `1px solid ${COLORS.borderSubtle}`,
                  }}
                >
                  <HealthStatusIcon status={item.status} />
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: FONT.sizeS,
                        fontWeight: FONT.weightSemibold,
                        color: item.status === "error" ? COLORS.statusError : COLORS.fg,
                      }}
                    >
                      {item.label}
                    </div>
                    <div
                      style={{
                        marginTop: "2px",
                        color: COLORS.fgDimmer,
                        fontSize: FONT.sizeXs,
                        lineHeight: 1.45,
                        overflowWrap: "anywhere",
                      }}
                    >
                      {item.detail}
                    </div>
                    {item.action && (
                      <div
                        style={{
                          marginTop: "3px",
                          color: COLORS.fgDim,
                          fontSize: FONT.sizeXs,
                          lineHeight: 1.45,
                        }}
                      >
                        {item.action}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <div
                style={{
                  padding: `${SPACING.sm} ${SPACING.md}`,
                  color: COLORS.fgDimmer,
                  fontSize: FONT.sizeXs,
                  lineHeight: 1.45,
                  overflowWrap: "anywhere",
                }}
              >
                <div>Config: {report.paths.config}</div>
                <div>Startup report: {report.paths.startupReport}</div>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function PackWorkbench({
  ctx,
  strings,
  onClose,
}: {
  ctx: UiContext;
  strings: UiStrings;
  onClose: () => void;
}): React.JSX.Element {
  const [packs, setPacks] = useState<readonly UiAppPackStatusEntry[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [diagnosis, setDiagnosis] = useState<UiAppPackDiagnoseResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"enable" | "disable" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repairPromptInserted, setRepairPromptInserted] = useState(false);

  const selectedPack = packs.find((pack) => packWorkbenchKey(pack) === selectedKey) ?? null;

  const refreshPacks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await ctx.app.listPacks();
      const next = sortPackStatuses(result.packs);
      setPacks(next);
      setSelectedKey((previous) => selectWorkbenchPack(previous, next));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      setError(reason);
      ctx.emitEvent("charminal-settings:write-failed", { field: "pack-workbench", reason });
    } finally {
      setLoading(false);
    }
  }, [ctx]);

  useEffect(() => {
    let aborted = false;
    setLoading(true);
    void ctx.app
      .listPacks()
      .then((result) => {
        if (aborted) return;
        const next = sortPackStatuses(result.packs);
        setPacks(next);
        setSelectedKey((previous) => selectWorkbenchPack(previous, next));
      })
      .catch((err) => {
        if (aborted) return;
        const reason = err instanceof Error ? err.message : String(err);
        setError(reason);
      })
      .finally(() => {
        if (!aborted) setLoading(false);
      });
    return () => {
      aborted = true;
    };
  }, [ctx]);

  useEffect(() => {
    const packRelatedFields = new Set([
      "activeAmbientUi",
      "activeScene",
      "primaryPersona",
      "activeUi",
      "disabledPacks",
    ]);
    const onConfigChanged = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      const field = typeof detail?.field === "string" ? detail.field : null;
      if (field === null || field.startsWith("pack-") || packRelatedFields.has(field)) {
        void refreshPacks();
      }
    };
    window.addEventListener("charminal-settings:config-changed", onConfigChanged);
    return () => window.removeEventListener("charminal-settings:config-changed", onConfigChanged);
  }, [refreshPacks]);

  useEffect(() => {
    if (selectedPack === null) {
      setDiagnosis(null);
      return;
    }
    let aborted = false;
    setRepairPromptInserted(false);
    setDiagnosis(null);
    void ctx.app
      .diagnosePack(selectedPack.id, selectedPack.kind || undefined)
      .then((result) => {
        if (!aborted) setDiagnosis(result);
      })
      .catch((err) => {
        if (aborted) return;
        const reason = err instanceof Error ? err.message : String(err);
        setError(reason);
        ctx.emitEvent("charminal-settings:write-failed", { field: "pack-diagnose", reason });
      });
    return () => {
      aborted = true;
    };
  }, [ctx, selectedPack]);

  const runPackAction = async (action: "enable" | "disable", packId?: string) => {
    const targetId = packId ?? selectedPack?.id;
    if (targetId === undefined) return;
    const target = packs.find((p) => p.id === targetId);
    if (target === undefined || target.origin !== "user") return;
    setBusy(action);
    setError(null);
    try {
      const result =
        action === "enable"
          ? await ctx.app.enablePack(targetId)
          : await ctx.app.disablePack(targetId);
      if (!result.ok) throw new Error(result.reason ?? `${action} failed`);
      await refreshPacks();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      setError(reason);
      ctx.emitEvent("charminal-settings:write-failed", { field: `pack-${action}`, reason });
    } finally {
      setBusy(null);
    }
  };

  const groups = groupPacksByKind(packs);
  const sectionRef = useRef<HTMLElement>(null);
  const repairAction = diagnosis?.ok === false ? "repair" : "improve";

  const selectPack = (key: string) => {
    setSelectedKey(key);
  };

  const insertRepairPrompt = async () => {
    if (selectedPack === null || diagnosis === null) return;
    setError(null);
    try {
      await ctx.app.insertPackRepairPrompt(
        selectedPack.id,
        selectedPack.kind || undefined,
        repairAction,
      );
      setRepairPromptInserted(true);
      onClose();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      setError(reason);
      ctx.emitEvent("charminal-settings:write-failed", { field: "pack-repair-prompt", reason });
    }
  };

  return (
    <section ref={sectionRef}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: SPACING.md,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: SPACING.sm, opacity: 0.78 }}>
          <Package size={14} aria-hidden="true" />
          <span>{strings.labelPacks}</span>
          {packs.length > 0 && (
            <span style={{ color: COLORS.fgDimmer, fontSize: FONT.sizeXs }}>{packs.length}</span>
          )}
        </div>
        <button
          type="button"
          onClick={refreshPacks}
          disabled={loading}
          aria-label="Refresh packs"
          title="Refresh packs"
          style={{
            width: "26px",
            height: "26px",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            borderRadius: RADIUS.sm,
            background: "transparent",
            color: COLORS.fgDimmer,
            cursor: loading ? "default" : "pointer",
            opacity: loading ? 0.4 : 0.7,
            padding: 0,
          }}
        >
          <RefreshCw size={13} aria-hidden="true" />
        </button>
      </div>

      <div
        style={{
          border: `1px solid ${COLORS.borderSubtle}`,
          borderRadius: RADIUS.md,
          overflow: "hidden",
          maxWidth: "520px",
        }}
      >
        <div style={{ maxHeight: "260px", overflowY: "auto" }}>
          {packs.length === 0 ? (
            <div
              style={{
                padding: `${SPACING.lg} ${SPACING.md}`,
                color: COLORS.fgDimmer,
                fontSize: FONT.sizeXs,
                textAlign: "center",
              }}
            >
              {loading ? strings.loadingPacks : strings.noPacksInstalled}
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.kind}>
                <div
                  style={{
                    padding: `${SPACING.xs} ${SPACING.md}`,
                    fontSize: "10px",
                    fontWeight: FONT.weightSemibold,
                    color: COLORS.fgDimmer,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    background: COLORS.bgInput,
                    borderBottom: `1px solid ${COLORS.borderSubtle}`,
                  }}
                >
                  {group.kind}
                </div>
                {group.packs.map((pack) => {
                  const key = packWorkbenchKey(pack);
                  const selected = key === selectedKey;
                  const isDisabled = pack.status === "disabled";
                  return (
                    <div
                      key={key}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        gap: SPACING.sm,
                        padding: `6px ${SPACING.md}`,
                        borderLeft: pack.isActive
                          ? `3px solid ${COLORS.accent}`
                          : "3px solid transparent",
                        borderBottom: `1px solid ${COLORS.borderSubtle}`,
                        background: selected ? COLORS.accentSoft : COLORS.bgPanel,
                        color: isDisabled ? COLORS.fgDim : COLORS.fg,
                        textAlign: "left",
                        font: "inherit",
                        fontSize: FONT.sizeS,
                        opacity: isDisabled ? 0.7 : 1,
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => selectPack(key)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: SPACING.sm,
                          flex: 1,
                          minWidth: 0,
                          border: "none",
                          background: "transparent",
                          color: "inherit",
                          cursor: "pointer",
                          textAlign: "left",
                          font: "inherit",
                          fontSize: "inherit",
                          padding: 0,
                        }}
                      >
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            flexShrink: 0,
                          }}
                        >
                          <PackStatusIndicator status={pack.status} />
                        </span>
                        <span
                          style={{
                            flex: 1,
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            textDecoration: isDisabled ? "line-through" : "none",
                          }}
                        >
                          {pack.id}
                        </span>
                        {pack.origin === "user" && (
                          <span
                            style={{
                              fontSize: "10px",
                              color: COLORS.fgDimmer,
                              padding: "1px 5px",
                              borderRadius: "3px",
                              border: `1px solid ${COLORS.borderSubtle}`,
                              flexShrink: 0,
                            }}
                          >
                            user
                          </span>
                        )}
                      </button>
                      <PackToggle
                        pack={pack}
                        busy={busy !== null}
                        onToggle={(action) => {
                          selectPack(key);
                          void runPackAction(action, pack.id);
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div
          style={{
            padding: `${SPACING.md} ${SPACING.md}`,
            background: COLORS.bgInput,
            borderTop: `1px solid ${COLORS.borderSubtle}`,
            minHeight: "140px",
            maxHeight: "220px",
            overflowY: "auto",
          }}
        >
          {selectedPack === null ? (
            <div
              style={{
                color: COLORS.fgDimmer,
                fontSize: FONT.sizeXs,
                padding: `${SPACING.xs} 0`,
              }}
            >
              {strings.selectPack}
            </div>
          ) : (
            <>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: SPACING.sm,
                  marginBottom: SPACING.sm,
                }}
              >
                <span
                  style={{
                    fontSize: FONT.sizeM,
                    fontWeight: FONT.weightSemibold,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                  }}
                >
                  {selectedPack.id}
                </span>
                <span
                  style={{
                    fontSize: "10px",
                    color: COLORS.fgDimmer,
                    padding: "1px 5px",
                    borderRadius: "3px",
                    background: COLORS.bgPanel,
                    flexShrink: 0,
                  }}
                >
                  {selectedPack.origin}
                </span>
                {diagnosis !== null && (
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: SPACING.xs,
                      marginLeft: "auto",
                      flexShrink: 0,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => void insertRepairPrompt()}
                      aria-label={
                        repairPromptInserted
                          ? strings.repairPromptInserted
                          : repairAction === "repair"
                            ? strings.repairPack
                            : strings.improvePack
                      }
                      title={
                        repairPromptInserted
                          ? strings.repairPromptInserted
                          : repairAction === "repair"
                            ? strings.repairPack
                            : strings.improvePack
                      }
                      style={{
                        width: "24px",
                        height: "24px",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        border: `1px solid ${COLORS.borderSubtle}`,
                        borderRadius: RADIUS.sm,
                        background: COLORS.bgPanel,
                        color: repairPromptInserted ? COLORS.accent : COLORS.fgDimmer,
                        cursor: "pointer",
                        padding: 0,
                      }}
                    >
                      <Wrench size={12} aria-hidden="true" />
                    </button>
                  </div>
                )}
              </div>
              <PackMetadata diagnosis={diagnosis} origin={selectedPack.origin} />

              {diagnosis === null ? (
                <div
                  style={{
                    color: COLORS.fgDimmer,
                    fontSize: FONT.sizeXs,
                    padding: `${SPACING.xs} 0`,
                  }}
                >
                  {strings.diagnosing}
                </div>
              ) : (
                <div style={{ display: "grid", gap: SPACING.sm }}>
                  <PackDiagnosisSummary diagnosis={diagnosis} strings={strings} />
                  {diagnosis.diagnostics
                    .filter((item) => item.severity !== "info")
                    .map((item) => (
                      <PackDiagnosticRow key={`${item.code}:${item.message}`} item={item} />
                    ))}
                  {diagnosis.diagnoses[0]?.entryPath && (
                    <div
                      title={diagnosis.diagnoses[0].entryPath}
                      style={{
                        color: COLORS.fgDimmer,
                        fontSize: FONT.sizeXs,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        opacity: 0.7,
                      }}
                    >
                      {diagnosis.diagnoses[0].entryPath}
                    </div>
                  )}
                  {diagnosis.recommendations.map((text) => (
                    <PackRecommendationRow key={text} text={text} />
                  ))}
                </div>
              )}
              {error && (
                <div
                  style={{
                    marginTop: SPACING.sm,
                    color: COLORS.statusError,
                    fontSize: FONT.sizeXs,
                  }}
                >
                  {error}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
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
  const [voiceFrequency, setVoiceFrequency] = useState<"on" | "off">("on");
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
      setVoiceFrequency(cur.voiceFrequency ?? "on");
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

  const onVoiceToggle = () => {
    const next: "on" | "off" = voiceFrequency === "on" ? "off" : "on";
    void applyConfigUpdate({
      next,
      prev: voiceFrequency,
      setLocal: setVoiceFrequency,
      write: (v) => ctx.app.setVoiceFrequency(v),
      emitEvent: (n, p) => ctx.emitEvent(n, p),
      field: "voiceFrequency",
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

  /** Quick action: 設定を閉じて terminal に host 所有の固定 prompt を pre-fill する。 */
  const onQuickActionClick = async (key: FixedTerminalPromptKey) => {
    fireCloseRequest();
    try {
      // pack は文字列を渡さない。host 所有の固定プロンプトを key で指す。
      // 設計境界: docs/decisions/input-prefill-boundary.md
      await ctx.app.insertFixedPrompt(key);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      ctx.emitEvent("charminal-settings:write-failed", {
        field: `fixed-prompt-${key}`,
        reason,
      });
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
        {/* Quick Actions */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: `${SPACING.xs} ${SPACING.md}`,
            fontSize: FONT.sizeXs,
            opacity: 0.5,
            marginBottom: SPACING.xl,
          }}
        >
          {QUICK_ACTION_KEYS.map((action) => (
            <button
              key={action.key}
              type="button"
              onClick={() => {
                void onQuickActionClick(action.key);
              }}
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
              {strings[action.stringKey]}
            </button>
          ))}
        </div>

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
              position: "relative",
              width: "100%",
              minWidth: "220px",
              maxWidth: "360px",
              background: COLORS.bgInput,
              padding: `6px ${SPACING.xl} 6px 10px`,
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
            <FolderOpen
              size={12}
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
          </button>

          {/* Persona */}
          <div style={{ opacity: 0.7 }}>{strings.labelPersona}</div>
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
          <div style={{ opacity: 0.7 }}>{strings.labelScene}</div>
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
          <div style={{ opacity: 0.7 }}>{strings.labelAura}</div>
          <div>
            <Toggle checked={auraEnabled} onChange={onAuraToggle} />
          </div>
        </div>

        {/* 24px gap */}
        <div style={{ height: "24px" }} />

        {/* グループ 2: Sound（mute icon + volume slider） */}
        <div style={gridStyle}>
          <div style={{ opacity: 0.7 }}>{strings.labelSound}</div>
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

        {/* Voice Summary（Sound の直下） */}
        <div style={{ ...gridStyle, marginTop: SPACING.md }}>
          <div style={{ opacity: 0.7 }}>{strings.voiceFrequency}</div>
          <div>
            <Toggle checked={voiceFrequency === "on"} onChange={onVoiceToggle} />
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
          {strings.voiceAppliesNextSession}
        </div>

        {/* 24px gap */}
        <div style={{ height: "24px" }} />

        {/* グループ 3: Terminal */}
        <div style={gridStyle}>
          <div style={{ opacity: 0.7 }}>{strings.labelAgent}</div>
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
          {strings.agentAppliesNextLaunch}
        </div>

        {/* 32px gap */}
        <div style={{ height: "32px" }} />

        <HealthDiagnostics ctx={ctx} strings={strings} />

        {/* 32px gap */}
        <div style={{ height: "32px" }} />

        <PackWorkbench ctx={ctx} strings={strings} onClose={fireCloseRequest} />
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

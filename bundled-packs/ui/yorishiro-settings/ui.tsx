/**
 * yorishiro-settings — Yorishiro の設定画面 bundled UI pack。
 *
 * activeUi を一時 swap して開閉する。閉じる時は直前の activeUi を ui-state-store
 * から取って setActiveUi で復元する（実際の setActiveUi 呼び出しは App.tsx 側で
 * `yorishiro-settings:close-requested` CustomEvent を listen して実行する）。
 *
 * Internal design-record: specs/2026-04-25-settings-screen-design.md
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  AppLanguage,
  Disposable,
  FixedTerminalPromptKey,
  ResolvedLanguage,
  SnapshotEntry,
  UiAppPackDiagnoseResponse,
  UiAppPackStatusEntry,
  UiContext,
  UiHealthReport,
  UiPackDefinition,
} from "@yorishiro/sdk";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Package,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  User,
  Volume2,
  VolumeX,
  Wrench,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { changeStrings, getStrings, type UiStrings } from "../../../src/i18n/strings";
import { buildRestoreRows } from "../../../src/runtime/history/describe-snapshot";
import { getBrowserLocales, resolveLanguage } from "../../../src/runtime/language/language";
import { type AvailableUpdate, checkForUpdate } from "../../../src/runtime/updater/app-updater";
import {
  isBundledYoriPersonaId,
  localizedYoriPersonaId,
} from "../../../src/runtime/user-pack-loader/config";
import simpleRoomManifest from "../../scenes/simple-room/manifest.json";
import { COLORS, FONT, RADIUS, SIZE, SPACING } from "./tokens";

export const SETTINGS_PACK_ID = "yorishiro-settings";
export const PREVIOUS_ACTIVE_UI_KEY = "previous-active-ui";
const DEFAULT_VRM_NAME = "Yori";
export const DEFAULT_VRM_THUMBNAIL_URL = "/models/Yori-thumbnail.png";
const YORI_VRM_ID = "builtin:yori";
const DEFAULT_SCENE_ID = simpleRoomManifest.id;

export type VrmMetaNormalized =
  | "notSpecified"
  | "unknown"
  | "allowed"
  | "disallowed"
  | "onlyAuthor"
  | "explicitlyLicensedPerson"
  | "everyone"
  | "personalNonProfit"
  | "personalProfit"
  | "corporation"
  | "prohibited"
  | "required"
  | "unnecessary"
  | "allowModification"
  | "allowModificationRedistribution";

export interface VrmMetaValue {
  readonly normalized: VrmMetaNormalized;
  readonly raw: string | null;
}

export interface VrmLicenseInfo {
  readonly name: string | null;
  readonly urls: readonly string[];
  readonly thirdPartyLicenses: string | null;
}

export interface VrmAvatarMeta {
  readonly specVersion: string;
  readonly specVersionDeclared: boolean;
  readonly exporterVersion: string | null;
  readonly name: string | null;
  readonly version: string | null;
  readonly authors: readonly string[];
  readonly contactInformation: string | null;
  readonly references: readonly string[];
  readonly license: VrmLicenseInfo;
  readonly allowedUser: VrmMetaValue;
  readonly avatarPermission: VrmMetaValue;
  readonly violentUsage: VrmMetaValue;
  readonly sexualUsage: VrmMetaValue;
  readonly commercialUsage: VrmMetaValue;
  readonly politicalOrReligiousUsage: VrmMetaValue;
  readonly antisocialOrHateUsage: VrmMetaValue;
  readonly redistribution: VrmMetaValue;
  readonly modification: VrmMetaValue;
  readonly creditNotation: VrmMetaValue;
}

export interface VrmAvatarEntry {
  readonly id: string;
  readonly fileName: string;
  readonly path: string;
  readonly size: number;
  readonly modifiedMs: number | null;
  readonly valid: boolean;
  readonly invalidReason: string | null;
  readonly meta: VrmAvatarMeta | null;
  readonly thumbnail?: VrmThumbnailRef | null;
}

export interface VrmThumbnailRef {
  readonly imageIndex: number;
  readonly mimeType: "image/png" | "image/jpeg";
  readonly byteLength: number;
}

export interface VrmCandidate {
  readonly id: string;
  readonly kind: "yori" | "file" | "missing";
  /** Catalog grouping is deliberately independent of the source path. Future bundled avatars join Yori here. */
  readonly catalogGroup: "bundled" | "imported" | "missing";
  readonly label: string;
  readonly path: string | null;
  readonly sourceId: string | null;
  readonly thumbnailCacheKey: string | null;
  readonly active: boolean;
  readonly valid: boolean;
  readonly invalidReason: string | null;
  readonly meta: VrmAvatarMeta | null;
  readonly thumbnail: VrmThumbnailRef | null;
}

type VrmCatalogNotice = {
  readonly kind: "removed" | "missing";
  readonly name: string;
};

export interface YoriVrmDetails {
  readonly author: string;
  readonly terms: readonly string[];
}

export function yoriVrmDetails(strings: UiStrings): YoriVrmDetails {
  return {
    author: strings.vrmYoriAuthor,
    terms: [
      strings.vrmYoriUseWithinApp,
      strings.vrmYoriAvatarPerformance,
      strings.vrmYoriStandaloneReuse,
      strings.vrmYoriViolentExpression,
      strings.vrmYoriSexualExpression,
    ],
  };
}

/** Yori を常に先頭に置き、保存済み absolute path が消えていても選択状態を失わない。 */
export function resolveVrmCandidates(
  entries: readonly VrmAvatarEntry[],
  activePath: string | null,
): readonly VrmCandidate[] {
  const files: VrmCandidate[] = entries.map((entry) => ({
    id: `file:${entry.id}`,
    kind: "file",
    catalogGroup: "imported",
    label: entry.fileName,
    path: entry.path,
    sourceId: entry.id,
    thumbnailCacheKey: `${entry.id}:${entry.size}:${entry.modifiedMs ?? "unknown"}`,
    active: activePath === entry.path,
    valid: entry.valid && entry.meta !== null,
    invalidReason: entry.invalidReason,
    meta: entry.meta,
    thumbnail: entry.thumbnail ?? null,
  }));
  const candidates: VrmCandidate[] = [
    {
      id: YORI_VRM_ID,
      kind: "yori",
      catalogGroup: "bundled",
      label: DEFAULT_VRM_NAME,
      path: null,
      sourceId: null,
      thumbnailCacheKey: null,
      active: activePath === null,
      valid: true,
      invalidReason: null,
      meta: null,
      thumbnail: null,
    },
    ...files,
  ];
  if (activePath !== null && !files.some((candidate) => candidate.path === activePath)) {
    candidates.push({
      id: "missing:active",
      kind: "missing",
      catalogGroup: "missing",
      label: activePath.split(/[\\/]/).pop() || activePath,
      path: activePath,
      sourceId: null,
      thumbnailCacheKey: null,
      active: true,
      valid: false,
      invalidReason: null,
      meta: null,
      thumbnail: null,
    });
  }
  return candidates;
}

export function activeVrmCandidateId(candidates: readonly VrmCandidate[]): string {
  return candidates.find((candidate) => candidate.active)?.id ?? YORI_VRM_ID;
}

/** setVrm を呼ぶ唯一の選択適用境界。無効・missing 候補は拒否する。 */
export function applyVrmCandidate(
  candidate: VrmCandidate,
  setVrm: (path: string | null) => void,
): boolean {
  if (candidate.kind === "yori") {
    setVrm(null);
    return true;
  }
  if (candidate.kind === "file" && candidate.valid && candidate.path !== null) {
    setVrm(candidate.path);
    return true;
  }
  return false;
}

/** 公開リポジトリ。Credits 画面の「View on GitHub」リンク先。 */
const YORISHIRO_REPO_URL = "https://github.com/sktkkoo/Yorishiro";

/** CREDITS.md（正本の全クレジット）。Credits 画面下部の「Full credits」リンク先。 */
const YORISHIRO_CREDITS_URL = "https://github.com/sktkkoo/Yorishiro/blob/main/CREDITS.md";

export interface VoiceMuteToggleState {
  readonly nextVolume: number;
  readonly restoreVolume: number;
}

/**
 * Voice Volume は 0 を exact mute として永続化する。mute 前の非ゼロ値を
 * UI-local に保持し、解除時に戻す。起動時から 0 の場合は 1 を fallback にする。
 */
export function resolveVoiceMuteToggle(
  currentVolume: number,
  previousNonZeroVolume: number,
): VoiceMuteToggleState {
  const current = Number.isFinite(currentVolume) ? Math.max(0, Math.min(1, currentVolume)) : 1;
  const previous = Number.isFinite(previousNonZeroVolume)
    ? Math.max(0, Math.min(1, previousNonZeroVolume))
    : 1;
  if (current > 0) {
    return { nextVolume: 0, restoreVolume: current };
  }
  const restoreVolume = previous > 0 ? previous : 1;
  return { nextVolume: restoreVolume, restoreVolume };
}

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
  /** Rapid optimistic updates may only let the newest request roll UI state back. */
  readonly shouldRollback?: () => boolean;
  /** Read the persisted canonical value after a failed write. */
  readonly readRollbackValue?: () => Promise<T>;
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
        new CustomEvent("yorishiro-settings:config-changed", {
          detail: { field: args.field },
        }),
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[yorishiro-settings] ${args.field} write failed:`, reason);
    args.emitEvent("yorishiro-settings:write-failed", { field: args.field, reason });
    if (args.shouldRollback?.() === false) return;
    let rollbackValue = args.prev;
    if (args.readRollbackValue) {
      try {
        rollbackValue = await args.readRollbackValue();
      } catch {
        // Keep the captured previous value if the canonical refresh also fails.
      }
    }
    if (args.shouldRollback?.() === false) return;
    args.setLocal(rollbackValue);
  }
}

interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export const TERMINAL_AGENT_OPTIONS = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
] as const satisfies readonly SelectOption[];

/** セッション再起動を伴う設定変更の種別。確認ダイアログの文言を分岐する。 */
export type NewSessionChangeKind = "persona" | "agent" | "voice";

export interface PendingNewSessionChange {
  readonly kind: NewSessionChangeKind;
  /** 現在値の表示名。voice では使わない。 */
  readonly currentLabel?: string;
  /** 変更後の表示名。voice では使わない。 */
  readonly nextLabel?: string;
  readonly run: () => void;
}

/**
 * 確認ダイアログの文言を操作種別ごとに解決する。伝えるのは「新しいセッション」という
 * システム語ではなく会話の行き先：persona は新しく始まる（引き継がない）、agent は
 * 区切り（戻れば続きから）、voice は継続。お別れの儀式は新規ペルソナ作成時の
 * goodbye switch（MCP 経路）だけで、ここは軽い確認に留める。strings.ts の doc も参照。
 */
export function resolveNewSessionConfirm(
  strings: UiStrings,
  change: Pick<PendingNewSessionChange, "kind" | "currentLabel" | "nextLabel">,
): { readonly message: string; readonly confirmLabel: string } {
  switch (change.kind) {
    case "persona":
      return {
        message: strings.personaSwitchConfirm
          .replace("{current}", change.currentLabel ?? "")
          .replace("{next}", change.nextLabel ?? ""),
        confirmLabel: strings.personaSwitchConfirmButton,
      };
    case "agent":
      return {
        message: strings.agentSwitchConfirm
          .replace("{current}", change.currentLabel ?? "")
          .replace("{next}", change.nextLabel ?? ""),
        confirmLabel: strings.agentSwitchConfirmButton,
      };
    case "voice":
      return {
        message: strings.voiceRestartConfirm,
        confirmLabel: strings.voiceRestartConfirmButton,
      };
  }
}

/**
 * ダイアログ本文用の agent 表示名。dropdown と違い experimental suffix は付けない。
 * agent を増やすときは TERMINAL_AGENT_OPTIONS に 1 行足せばここにも自動で流れる。
 * 未知の id は raw id に fallback する（文言側は {current}/{next} placeholder のみで
 * agent 名を hard-code しない）。
 */
export function terminalAgentLabel(id: string): string {
  return TERMINAL_AGENT_OPTIONS.find((opt) => opt.value === id)?.label ?? id;
}

interface CreditLine {
  /** 主たる表記（asset 名 / library 名）。 */
  readonly text: string;
  /** 右側に淡く添える補足（license / 提供元）。 */
  readonly note?: string;
}

interface CreditSection {
  readonly label: string;
  readonly lines: readonly CreditLine[];
  /** section 下に添える注記（例: Yori の利用条件）。 */
  readonly footnote?: string;
}

/**
 * Credits 画面に表示する帰属の構造化リスト。アプリにバンドルされている asset と
 * 使用 OSS の出所を示す。pixiv VRMA セットの帰属表記は License 上の義務
 * （CREDITS.md 参照）、その他は courtesy。完全な一覧は CREDITS.md が正本。
 *
 * Credits 画面の中身は app language に関わらず常に英語で出す（library 名 /
 * license / 帰属はそのまま読めるのが望ましく、訳すと座りが悪い）。pixiv の必須
 * クレジットも英語表記で規約を満たす。よって i18n strings を介さず literal で持つ。
 */
export function creditsSections(): readonly CreditSection[] {
  return [
    {
      // LUCAS には出所リンクを貼らない：CREDITS.md の「本件について連絡しないでほしい」
      // という意向を尊重し、social へ誘導しない。
      // footnote は VRM 埋め込み meta の利用条件を英語に書き写した固定文（CREDITS.md と一致）。
      label: "Character",
      lines: [{ text: "Yori — character model by LUCAS" }],
      footnote:
        "Use within Yorishiro is permitted for everyone. Standalone redistribution or reuse of the model is prohibited. Violent expression is permitted; sexual expression is not.",
    },
    {
      // 用途（idle / additional 等）は変わるので書かない。提供元を並列に挙げるだけ。
      // pixiv は規約上の必須クレジット文言をそのまま保持する。
      label: "Animations",
      lines: [
        { text: "Character animation credits to pixiv Inc.'s VRoid Project" },
        { text: "Rokoko", note: "Rokoko Asset license" },
        { text: "Adobe Mixamo", note: "Mixamo License" },
      ],
    },
    {
      // bundled ambient。Yori の事前収録 voice は未同梱なので載せない。
      label: "Audio",
      lines: [{ text: "Pixabay", note: "Pixabay Content License" }],
    },
    {
      label: "Built with",
      lines: [
        { text: "Tauri", note: "MIT / Apache-2.0" },
        { text: "React", note: "MIT" },
        { text: "Three.js", note: "MIT" },
        { text: "React Three Fiber · drei", note: "MIT · Poimandres" },
        { text: "@pixiv/three-vrm", note: "MIT · pixiv Inc." },
        { text: "xterm.js", note: "MIT" },
        { text: "leva", note: "MIT · Poimandres" },
      ],
    },
    {
      label: "Specifications",
      lines: [
        { text: "VRM / VRMA", note: "VRM Consortium" },
        { text: "glTF 2.0", note: "Khronos Group" },
      ],
    },
  ];
}

function formatPackOptionLabel(pack: {
  readonly id: string;
  readonly name?: string;
  readonly origin: "bundled" | "user";
}): string {
  return pack.name ?? pack.id;
}

export function filterPersonaOptionsForLanguage<T extends { readonly id: string }>(
  personas: readonly T[],
  language: ResolvedLanguage,
): T[] {
  const yoriId = localizedYoriPersonaId(language);
  return personas.filter((p) => !isBundledYoriPersonaId(p.id) || p.id === yoriId);
}

export function resolvePersonaSelectValue(
  primaryPersona: string | null,
  language: ResolvedLanguage,
): string {
  return primaryPersona === null || isBundledYoriPersonaId(primaryPersona)
    ? localizedYoriPersonaId(language)
    : primaryPersona;
}

export function configPrimaryPersonaForSelection(id: string): string | null {
  return isBundledYoriPersonaId(id) ? null : id;
}

export function resolveSceneSelectValue(activeScene: string | null): string {
  return activeScene ?? DEFAULT_SCENE_ID;
}

export function configActiveSceneForSelection(id: string): string | null {
  return id === DEFAULT_SCENE_ID ? null : id;
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
  disabled = false,
}: {
  value: string;
  options: readonly SelectOption[];
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  /** value === "" の時に表示する disabled option（読み込み中など）。 */
  loadingPlaceholder?: string;
  emptyLabel?: string;
  /** true で操作不可。値が外部要因で固定されている（例: defaultProfile）ときに使う。 */
  disabled?: boolean;
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
        disabled={disabled}
        style={{
          appearance: "none",
          WebkitAppearance: "none",
          MozAppearance: "none",
          background: COLORS.bgInput,
          border: `1px solid ${COLORS.borderSubtle}`,
          borderRadius: RADIUS.sm,
          padding: `${SPACING.sm} ${SPACING.xl} ${SPACING.sm} ${SPACING.md}`,
          color: disabled ? COLORS.fgDim : COLORS.fg,
          font: "inherit",
          fontFamily: FONT.family,
          fontSize: FONT.sizeS,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.6 : 1,
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

function NewSessionConfirmDialog({
  message,
  cancelLabel,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  readonly message: string;
  readonly cancelLabel: string;
  readonly confirmLabel: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10_000,
        display: "grid",
        placeItems: "center",
        background: "rgba(8, 10, 12, 0.58)",
        padding: SPACING.lg,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={message}
        style={{
          width: "min(360px, 100%)",
          borderRadius: RADIUS.md,
          border: `1px solid ${COLORS.borderSubtle}`,
          background: COLORS.bgPanel,
          boxShadow: "0 18px 48px rgba(0, 0, 0, 0.42)",
          padding: SPACING.lg,
          color: COLORS.fg,
        }}
      >
        <div style={{ fontSize: FONT.sizeS, lineHeight: 1.55, color: COLORS.fg }}>{message}</div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: SPACING.sm,
            marginTop: SPACING.lg,
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            style={{
              border: `1px solid ${COLORS.borderSubtle}`,
              borderRadius: RADIUS.sm,
              background: COLORS.bgInput,
              color: COLORS.fgDim,
              font: "inherit",
              fontSize: FONT.sizeXs,
              padding: `${SPACING.xs} ${SPACING.md}`,
              cursor: "pointer",
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{
              border: `1px solid ${COLORS.accentBorder}`,
              borderRadius: RADIUS.sm,
              background: COLORS.accentSoft,
              color: COLORS.accent,
              font: "inherit",
              fontSize: FONT.sizeXs,
              padding: `${SPACING.xs} ${SPACING.md}`,
              cursor: "pointer",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
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
  if (origin === "bundled") return "Bundled with Yorishiro";
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
      ctx.emitEvent("yorishiro-settings:write-failed", { field: "health-report", reason });
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

/**
 * 設定画面の restore section。crash していなくても、snapshot 一覧から手動で
 * ~/.yorishiro を以前の状態に戻す。最新は「今の状態」なのでボタンを出さない。
 * 推奨タグは crash 画面にだけ残し、設定画面では行の内容を淡々と読めるようにする。
 * 確認 → restore → reload で config/init.js も再適用する。
 */
function SnapshotRestoreSection({
  ctx,
  locale,
  strings,
}: {
  ctx: UiContext;
  locale: ResolvedLanguage;
  strings: UiStrings;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<ReadonlyArray<SnapshotEntry> | null>(null);
  const [loading, setLoading] = useState(false);
  const [restorePending, setRestorePending] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    ctx.history
      .list()
      .then((next) => setSnapshots(next))
      .catch(() => setSnapshots([]))
      .finally(() => setLoading(false));
  }, [ctx.history]);

  const restore = useCallback(
    async (seq: number) => {
      setRestorePending(true);
      try {
        await ctx.history.restore(seq);
      } finally {
        setRestorePending(false);
      }
    },
    [ctx.history],
  );

  useEffect(() => {
    if (open && snapshots === null) refresh();
  }, [open, snapshots, refresh]);

  const rows = snapshots
    ? buildRestoreRows(snapshots, Date.now(), changeStrings(strings), locale)
    : [];
  let listContent: React.ReactNode;
  if (snapshots === null) {
    listContent = (
      <div style={{ padding: SPACING.md, color: COLORS.fgDimmer, fontSize: FONT.sizeXs }}>
        Checking…
      </div>
    );
  } else if (rows.length === 0) {
    listContent = (
      <div style={{ padding: SPACING.md, color: COLORS.fgDimmer, fontSize: FONT.sizeXs }}>
        {strings.restoreEmpty}
      </div>
    );
  } else {
    listContent = rows.map((row) => (
      <div
        key={row.seq}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: SPACING.md,
          padding: `${SPACING.sm} ${SPACING.md}`,
          borderBottom: `1px solid ${COLORS.borderSubtle}`,
        }}
      >
        <span
          style={{
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: SPACING.xs,
            fontSize: FONT.sizeXs,
            color: COLORS.fgDim,
            overflowWrap: "anywhere",
            lineHeight: 1.45,
          }}
        >
          <span
            style={{
              minWidth: 0,
              overflowWrap: "anywhere",
              color: row.startupStatus === "error" ? COLORS.statusWarning : undefined,
            }}
          >
            {row.changeText}
          </span>
          <span style={{ color: COLORS.fgDimmer }}>· {row.timeText}</span>
          {row.isLatest ? (
            <span style={{ color: COLORS.fgDimmer }}>{strings.restoreLatestTag}</span>
          ) : null}
          {row.changedItems.length > 0 ? (
            <span
              style={{
                display: "block",
                width: "100%",
                color: COLORS.fgDimmer,
                fontSize: "10px",
                lineHeight: 1.3,
              }}
            >
              {row.changedItems.join(", ")}
            </span>
          ) : null}
        </span>
        {/* 最新（現在の状態）は戻しても no-op なのでボタンを出さない。 */}
        {row.isLatest ? null : (
          <button
            type="button"
            disabled={restorePending}
            onClick={() => void restore(row.seq)}
            style={{
              flexShrink: 0,
              border: `1px solid ${COLORS.borderSubtle}`,
              borderRadius: RADIUS.sm,
              background: COLORS.bgButton,
              color: COLORS.fg,
              font: "inherit",
              fontSize: FONT.sizeXs,
              padding: `${SPACING.xs} ${SPACING.sm}`,
              cursor: restorePending ? "default" : "pointer",
              opacity: restorePending ? 0.5 : 1,
            }}
          >
            {strings.restoreButton}
          </button>
        )}
      </div>
    ));
  }

  return (
    <section>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
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
          <RotateCcw size={14} aria-hidden="true" color={COLORS.fg} />
          <span>{strings.labelRestore}</span>
        </button>
        {open && (
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            aria-label="Refresh snapshots"
            title="Refresh snapshots"
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
        )}
      </div>

      {open && (
        <>
          <div
            style={{
              marginTop: SPACING.sm,
              color: COLORS.fgDimmer,
              fontSize: FONT.sizeXs,
              lineHeight: 1.45,
              maxWidth: "520px",
            }}
          >
            {strings.restoreIntro}
          </div>
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
            <div style={{ maxHeight: "320px", overflowY: "auto" }}>{listContent}</div>
          </div>
        </>
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
      ctx.emitEvent("yorishiro-settings:write-failed", { field: "pack-workbench", reason });
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
    window.addEventListener("yorishiro-settings:config-changed", onConfigChanged);
    return () => window.removeEventListener("yorishiro-settings:config-changed", onConfigChanged);
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
        ctx.emitEvent("yorishiro-settings:write-failed", { field: "pack-diagnose", reason });
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
      ctx.emitEvent("yorishiro-settings:write-failed", { field: `pack-${action}`, reason });
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
    if (selectedPack === null || diagnosis === null || repairPromptInserted) return;
    setRepairPromptInserted(true);
    setError(null);
    try {
      await ctx.app.insertPackRepairPrompt(
        selectedPack.id,
        selectedPack.kind || undefined,
        repairAction,
      );
      onClose();
    } catch (err) {
      setRepairPromptInserted(false);
      const reason = err instanceof Error ? err.message : String(err);
      setError(reason);
      ctx.emitEvent("yorishiro-settings:write-failed", { field: "pack-repair-prompt", reason });
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
                      disabled={repairPromptInserted}
                      onClick={() => void insertRepairPrompt()}
                      aria-label={
                        repairAction === "repair" ? strings.repairPack : strings.improvePack
                      }
                      title={repairAction === "repair" ? strings.repairPack : strings.improvePack}
                      style={{
                        width: "24px",
                        height: "24px",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        border: `1px solid ${COLORS.borderSubtle}`,
                        borderRadius: RADIUS.sm,
                        background: COLORS.bgPanel,
                        color: COLORS.fgDimmer,
                        cursor: repairPromptInserted ? "default" : "pointer",
                        opacity: repairPromptInserted ? 0.4 : 1,
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

const GRID_LABEL_COLUMN_WIDTH = "120px";

/** grid の label-value pair 用の共通 grid style。 */
const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: `${GRID_LABEL_COLUMN_WIDTH} 1fr`,
  gap: `${SPACING.sm} ${SPACING.md}`,
  alignItems: "center",
};

const separatedToggleRowStyle: React.CSSProperties = {
  paddingTop: SPACING.xs,
};

const MOTION_LEVEL_LABEL_LEFTS = ["0%", "33.3333%", "66.6667%", "100%"] as const;

/** range の 0/1/2/3 tick にレベル名を固定する。 */
function motionLevelLabelStyle(index: number): React.CSSProperties {
  const isFirst = index === 0;
  const isLast = index === MOTION_LEVEL_LABEL_LEFTS.length - 1;
  return {
    position: "absolute",
    left: MOTION_LEVEL_LABEL_LEFTS[index] ?? "0%",
    transform: isFirst ? "translateX(0)" : isLast ? "translateX(-100%)" : "translateX(-50%)",
    whiteSpace: "nowrap",
    textAlign: isFirst ? "left" : isLast ? "right" : "center",
  };
}

const CREDITS_RISE_KEYFRAMES = `
@keyframes yorishiro-credits-rise {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}`;

/**
 * Credits 画面。設定画面の CREDITS action から開く overlay。app identity（名称 /
 * version / license / repo）に続けて、bundle 済み asset と使用 OSS の帰属を表示する。
 * pixiv VRMA の表記は License 上の義務、その他は courtesy（正本は CREDITS.md）。
 *
 * 中身は app language に関わらず常に英語（[[creditsSections]] 参照）。
 *
 * 美学：Yorishiro は terminal の app なので monospace を活かした抑制的・編集的な
 * 版面で「ちゃんと手入れされている」ことを伝える（presence over spectacle）。
 * 読み込み時に section を控えめに rise させる以上の演出はしない。
 */
function CreditsOverlay({
  ctx,
  onBack,
}: {
  ctx: UiContext;
  onBack: () => void;
}): React.JSX.Element {
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    let active = true;
    ctx.app
      .getVersion()
      .then((v) => {
        if (active) setVersion(v);
      })
      .catch(() => {
        /* dev / 非 Tauri 文脈では version を出さない */
      });
    return () => {
      active = false;
    };
  }, [ctx.app]);

  const sections = creditsSections();

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: COLORS.bgPanel,
        color: COLORS.fg,
        fontFamily: FONT.family,
        display: "flex",
        flexDirection: "column",
        pointerEvents: "auto",
      }}
    >
      <style>{CREDITS_RISE_KEYFRAMES}</style>

      {/* header: 戻る button のみ、設定画面の close header と対称 */}
      <header
        style={{
          padding: `${SPACING.lg} ${SPACING.xl}`,
          display: "flex",
          alignItems: "center",
        }}
      >
        <button
          type="button"
          onClick={onBack}
          style={{
            cursor: "pointer",
            opacity: 0.8,
            display: "flex",
            alignItems: "center",
            gap: SPACING.xs,
            padding: `${SPACING.xs} 10px`,
            borderRadius: RADIUS.sm,
            background: COLORS.bgInputHover,
            color: "inherit",
            border: "none",
            font: "inherit",
            fontSize: FONT.sizeXs,
          }}
        >
          <span aria-hidden="true">←</span>
          Back
        </button>
      </header>

      <main
        style={{
          flex: 1,
          padding: `0 ${SPACING.xl} ${SPACING.xxl}`,
          width: "100%",
          maxWidth: "560px",
          overflowY: "auto",
        }}
      >
        {/* app identity */}
        <div
          style={{
            paddingBottom: SPACING.lg,
            marginBottom: SPACING.lg,
            borderBottom: `1px solid ${COLORS.borderSubtle}`,
            animation: "yorishiro-credits-rise 360ms ease both",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: SPACING.sm }}>
            <span
              style={{
                fontSize: "22px",
                fontWeight: FONT.weightSemibold,
                letterSpacing: "0.01em",
              }}
            >
              Yorishiro
            </span>
            {version && (
              <span
                style={{
                  fontSize: FONT.sizeXs,
                  opacity: 0.85,
                  padding: `2px ${SPACING.sm}`,
                  borderRadius: RADIUS.sm,
                  background: COLORS.accentSoft,
                  border: `1px solid ${COLORS.accentBorder}`,
                }}
              >
                v{version}
              </span>
            )}
          </div>
          {/* license + repo は app identity の一部としてアプリ名の直下に置く */}
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: SPACING.sm,
              marginTop: SPACING.sm,
              fontSize: FONT.sizeXs,
            }}
          >
            <span style={{ opacity: 0.4 }}>MIT License</span>
            <span style={{ opacity: 0.25 }} aria-hidden="true">
              ·
            </span>
            <button
              type="button"
              onClick={() => {
                void ctx.app.openExternal(YORISHIRO_REPO_URL);
              }}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                font: "inherit",
                fontSize: FONT.sizeXs,
                color: COLORS.accent,
                textDecoration: "underline",
                textDecorationColor: "currentColor",
                textUnderlineOffset: "2px",
              }}
            >
              View on GitHub
            </button>
          </div>
        </div>

        {/* credit sections */}
        {sections.map((section, i) => (
          <div
            key={section.label}
            style={{
              marginBottom: SPACING.xl,
              animation: `yorishiro-credits-rise 360ms ease both`,
              animationDelay: `${(i + 1) * 45}ms`,
            }}
          >
            <div
              style={{
                fontSize: FONT.sizeXs,
                opacity: 0.4,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                marginBottom: SPACING.sm,
              }}
            >
              {section.label}
            </div>
            {section.lines.map((line) => (
              <div
                key={line.text}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: SPACING.md,
                  padding: `${SPACING.xs} 0`,
                  lineHeight: "1.5",
                }}
              >
                <span style={{ fontSize: FONT.sizeS, opacity: 0.82 }}>{line.text}</span>
                {line.note && (
                  <span
                    style={{
                      fontSize: FONT.sizeXs,
                      opacity: 0.38,
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}
                  >
                    {line.note}
                  </span>
                )}
              </div>
            ))}
            {section.footnote && (
              <div
                style={{
                  display: "flex",
                  gap: SPACING.sm,
                  marginTop: SPACING.xs,
                  fontSize: FONT.sizeXs,
                  lineHeight: "1.6",
                }}
              >
                <span style={{ opacity: 0.3, flexShrink: 0 }}>License</span>
                <span style={{ opacity: 0.5 }}>{section.footnote}</span>
              </div>
            )}
          </div>
        ))}

        {/* full credits は CREDITS.md（正本）へ誘導。上部 View on GitHub（repo）とは役割を分ける。 */}
        <div
          style={{
            marginTop: SPACING.sm,
            paddingTop: SPACING.lg,
            borderTop: `1px solid ${COLORS.borderSubtle}`,
          }}
        >
          <button
            type="button"
            onClick={() => {
              void ctx.app.openExternal(YORISHIRO_CREDITS_URL);
            }}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              font: "inherit",
              fontSize: FONT.sizeXs,
              color: COLORS.accent,
              textDecoration: "underline",
              textDecorationColor: "currentColor",
              textUnderlineOffset: "2px",
            }}
          >
            Full credits and licenses
          </button>
        </div>
      </main>
    </div>
  );
}

const VRM_META_STRING_KEYS = {
  notSpecified: "vrmNotSpecified",
  unknown: "vrmUnknown",
  allowed: "vrmPermissionAllowed",
  disallowed: "vrmPermissionDisallowed",
  onlyAuthor: "vrmPermissionOnlyAuthor",
  explicitlyLicensedPerson: "vrmPermissionExplicitlyLicensedPerson",
  everyone: "vrmPermissionEveryone",
  personalNonProfit: "vrmPermissionPersonalNonProfit",
  personalProfit: "vrmPermissionPersonalProfit",
  corporation: "vrmPermissionCorporation",
  prohibited: "vrmPermissionProhibited",
  required: "vrmPermissionRequired",
  unnecessary: "vrmPermissionUnnecessary",
  allowModification: "vrmPermissionAllowModification",
  allowModificationRedistribution: "vrmPermissionAllowModificationRedistribution",
} as const satisfies Record<VrmMetaNormalized, keyof UiStrings>;

export function formatVrmMetaValue(value: VrmMetaValue, strings: UiStrings): string {
  const localized = strings[VRM_META_STRING_KEYS[value.normalized]];
  if (value.normalized === "unknown" && value.raw) return `${localized}: ${value.raw}`;
  return localized;
}

export function formatVrmSpecVersion(
  meta: Pick<VrmAvatarMeta, "specVersion" | "specVersionDeclared">,
  strings: UiStrings,
): string {
  if (meta.specVersionDeclared) return meta.specVersion;
  return strings.vrmSpecVersionNotDeclared.replace("{version}", meta.specVersion);
}

function VrmDetailRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(120px, 0.38fr) 1fr",
        gap: SPACING.sm,
      }}
    >
      <div style={{ color: COLORS.fgDimmer }}>{label}</div>
      <div style={{ minWidth: 0, overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{value}</div>
    </div>
  );
}

export function safeVrmExternalUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function VrmExternalLinks({
  values,
  onOpenExternal,
}: {
  readonly values: readonly string[];
  readonly onOpenExternal: (url: string) => Promise<void>;
}): React.JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "3px" }}>
      {values.map((value) => {
        const safeUrl = safeVrmExternalUrl(value);
        return safeUrl ? (
          <button
            key={value}
            type="button"
            onClick={() => void onOpenExternal(safeUrl)}
            style={{
              border: 0,
              padding: 0,
              background: "transparent",
              color: COLORS.accent,
              font: "inherit",
              textAlign: "left",
              textDecoration: "underline",
              textUnderlineOffset: "2px",
              overflowWrap: "anywhere",
              cursor: "pointer",
            }}
          >
            {value}
          </button>
        ) : (
          <span key={value}>{value}</span>
        );
      })}
    </div>
  );
}

export function vrmCandidateDisplayName(candidate: VrmCandidate): string {
  const metadataName = candidate.meta?.name?.trim();
  if (metadataName) return metadataName;
  return candidate.label.replace(/\.vrm$/i, "") || candidate.label;
}

export function sortVrmCandidates(candidates: readonly VrmCandidate[]): readonly VrmCandidate[] {
  return [...candidates].sort((left, right) => {
    const groupRank = { bundled: 0, imported: 1, missing: 2 } as const;
    if (left.catalogGroup !== right.catalogGroup) {
      return groupRank[left.catalogGroup] - groupRank[right.catalogGroup];
    }
    if (left.active !== right.active) return left.active ? -1 : 1;
    if (left.valid !== right.valid) return left.valid ? -1 : 1;
    return vrmCandidateDisplayName(left).localeCompare(vrmCandidateDisplayName(right), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

export function filterVrmCandidates(
  candidates: readonly VrmCandidate[],
  query: string,
): readonly VrmCandidate[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return candidates;
  return candidates.filter((candidate) =>
    [vrmCandidateDisplayName(candidate), candidate.label, ...(candidate.meta?.authors ?? [])].some(
      (value) => value.toLocaleLowerCase().includes(normalized),
    ),
  );
}

function vrmSummaryMark(value: VrmMetaValue): "✓" | "×" | "—" | "•" {
  if (value.normalized === "disallowed" || value.normalized === "prohibited") return "×";
  if (value.normalized === "notSpecified" || value.normalized === "unknown") return "—";
  if (
    value.normalized === "allowed" ||
    value.normalized === "everyone" ||
    value.normalized === "unnecessary" ||
    value.normalized === "allowModification" ||
    value.normalized === "allowModificationRedistribution"
  ) {
    return "✓";
  }
  return "•";
}

interface VrmRestrictionGroup {
  readonly label: string;
  readonly items: readonly string[];
  readonly tone: string;
}

function summarizeVrmRestrictions(
  meta: VrmAvatarMeta,
  strings: UiStrings,
): readonly VrmRestrictionGroup[] {
  const restrictions: readonly [string, VrmMetaValue][] = [
    [strings.vrmRestrictionViolence, meta.violentUsage],
    [strings.vrmRestrictionSexual, meta.sexualUsage],
    [strings.vrmRestrictionPolitical, meta.politicalOrReligiousUsage],
    [strings.vrmRestrictionAntisocial, meta.antisocialOrHateUsage],
  ];
  const blocked = restrictions
    .filter(([, value]) => value.normalized === "disallowed" || value.normalized === "prohibited")
    .map(([label]) => label);
  const allowed = restrictions
    .filter(([, value]) => value.normalized === "allowed")
    .map(([label]) => label);
  const unstated = restrictions
    .filter(([, value]) => value.normalized === "notSpecified" || value.normalized === "unknown")
    .map(([label]) => label);
  const groups: VrmRestrictionGroup[] = [];
  if (blocked.length) {
    groups.push({
      label: strings.vrmRestrictionsBlocked,
      items: blocked,
      tone: COLORS.statusError,
    });
  }
  if (allowed.length) {
    groups.push({ label: strings.vrmRestrictionsAllowed, items: allowed, tone: COLORS.fg });
  }
  if (unstated.length) {
    groups.push({ label: strings.vrmRestrictionsUnstated, items: unstated, tone: COLORS.fgDimmer });
  }
  return groups;
}

function VrmRestrictionList({
  groups,
  strings,
}: {
  readonly groups: readonly VrmRestrictionGroup[];
  readonly strings: UiStrings;
}): React.JSX.Element {
  return (
    <fieldset
      aria-label={strings.vrmContentRestrictions}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "3px",
        margin: 0,
        padding: 0,
        border: 0,
      }}
    >
      {groups.map((group) => (
        <div key={group.label} style={{ color: group.tone }}>
          <span style={{ fontWeight: FONT.weightSemibold }}>{group.label}</span>
          <span>: {group.items.join(", ")}</span>
        </div>
      ))}
    </fieldset>
  );
}

function VrmSummaryRow({
  label,
  value,
  mark = "•",
}: {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly mark?: "✓" | "×" | "—" | "•";
}): React.JSX.Element {
  const tone = mark === "×" ? COLORS.statusError : mark === "—" ? COLORS.fgDimmer : COLORS.fg;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "18px minmax(104px, 0.38fr) minmax(0, 1fr)",
        gap: SPACING.sm,
        alignItems: "start",
        minHeight: "28px",
      }}
    >
      <span aria-hidden="true" style={{ color: tone, fontWeight: FONT.weightSemibold }}>
        {mark}
      </span>
      <span style={{ color: COLORS.fgDim }}>{label}</span>
      <span style={{ color: tone, overflowWrap: "anywhere" }}>{value}</span>
    </div>
  );
}

type VrmThumbnailCacheEntry =
  | { readonly phase: "loading"; readonly lastUsed: number }
  | {
      readonly phase: "ready";
      readonly url: string;
      readonly byteLength: number;
      readonly lastUsed: number;
    }
  | { readonly phase: "unavailable"; readonly lastUsed: number };

interface VrmThumbnailQueueItem {
  readonly key: string;
  readonly id: string;
  readonly mimeType: string;
}

function useVrmThumbnailCache(): {
  readonly get: (candidate: VrmCandidate) => VrmThumbnailCacheEntry | undefined;
  readonly ensure: (candidate: VrmCandidate, priority?: boolean) => void;
} {
  const entries = useRef(new Map<string, VrmThumbnailCacheEntry>());
  const queue = useRef<VrmThumbnailQueueItem[]>([]);
  const active = useRef(0);
  const disposed = useRef(false);
  const [, setRevision] = useState(0);

  const trim = useCallback(() => {
    const readyEntries = [...entries.current.entries()]
      .filter(([, entry]) => entry.phase === "ready")
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    let readyBytes = readyEntries.reduce(
      (total, [, entry]) => total + (entry.phase === "ready" ? entry.byteLength : 0),
      0,
    );
    while (readyEntries.length > 48 || readyBytes > 64 * 1024 * 1024) {
      const oldest = readyEntries.shift();
      if (!oldest) break;
      const entry = entries.current.get(oldest[0]);
      if (entry?.phase === "ready") {
        readyBytes -= entry.byteLength;
        URL.revokeObjectURL(entry.url);
      }
      entries.current.delete(oldest[0]);
    }
  }, []);

  const pump = useCallback(() => {
    while (!disposed.current && active.current < 3 && queue.current.length > 0) {
      const item = queue.current.shift();
      if (!item || entries.current.get(item.key)?.phase !== "loading") continue;
      active.current += 1;
      void invoke<ArrayBuffer>("read_vrm_thumbnail", { id: item.id })
        .then((payload) => {
          if (disposed.current) return;
          const bytes = payload instanceof ArrayBuffer ? payload : new Uint8Array(payload).buffer;
          const url = URL.createObjectURL(new Blob([bytes], { type: item.mimeType }));
          entries.current.set(item.key, {
            phase: "ready",
            url,
            byteLength: bytes.byteLength,
            lastUsed: Date.now(),
          });
          trim();
          setRevision((value) => value + 1);
        })
        .catch(() => {
          if (disposed.current) return;
          entries.current.set(item.key, { phase: "unavailable", lastUsed: Date.now() });
          setRevision((value) => value + 1);
        })
        .finally(() => {
          active.current -= 1;
          pump();
        });
    }
  }, [trim]);

  const ensure = useCallback(
    (candidate: VrmCandidate, priority = false) => {
      const key = candidate.thumbnailCacheKey;
      const id = candidate.sourceId;
      const thumbnail = candidate.thumbnail;
      if (!key || !id || !thumbnail || !candidate.valid) return;
      const existing = entries.current.get(key);
      if (existing?.phase === "ready") {
        entries.current.set(key, { ...existing, lastUsed: Date.now() });
        return;
      }
      if (existing?.phase === "unavailable") return;
      if (existing?.phase === "loading") {
        if (priority) {
          const index = queue.current.findIndex((item) => item.key === key);
          if (index > 0) {
            const [item] = queue.current.splice(index, 1);
            if (item) queue.current.unshift(item);
          }
        }
        return;
      }
      entries.current.set(key, { phase: "loading", lastUsed: Date.now() });
      const item = { key, id, mimeType: thumbnail.mimeType };
      if (priority) queue.current.unshift(item);
      else queue.current.push(item);
      setRevision((value) => value + 1);
      pump();
    },
    [pump],
  );

  useEffect(
    () => () => {
      disposed.current = true;
      queue.current = [];
      for (const entry of entries.current.values()) {
        if (entry.phase === "ready") URL.revokeObjectURL(entry.url);
      }
      entries.current.clear();
    },
    [],
  );

  const get = useCallback((candidate: VrmCandidate) => {
    const key = candidate.thumbnailCacheKey;
    return key ? entries.current.get(key) : undefined;
  }, []);
  return useMemo(() => ({ get, ensure }), [ensure, get]);
}

function VrmThumbnail({
  candidate,
  cache,
  priority = false,
  detail = false,
  strings,
}: {
  readonly candidate: VrmCandidate | undefined;
  readonly cache: ReturnType<typeof useVrmThumbnailCache>;
  readonly priority?: boolean;
  readonly detail?: boolean;
  readonly strings: UiStrings;
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [bundledThumbnailFailed, setBundledThumbnailFailed] = useState(false);
  const cacheEntry = candidate ? cache.get(candidate) : undefined;
  const size = detail ? SIZE.vrmThumbnailPreview : SIZE.vrmThumbnailList;
  const bundledThumbnailReady = candidate?.kind === "yori" && !bundledThumbnailFailed;

  useEffect(() => {
    if (!candidate?.thumbnail || !candidate.valid) return;
    if (priority) {
      const timeout = window.setTimeout(() => cache.ensure(candidate, true), 80);
      return () => window.clearTimeout(timeout);
    }
    if (typeof IntersectionObserver === "undefined") return;
    const element = containerRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) {
          cache.ensure(candidate);
          observer.disconnect();
        }
      },
      { rootMargin: "160px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [cache, candidate, priority]);

  const displayName = candidate ? vrmCandidateDisplayName(candidate) : "";
  const accessibleLabel = detail
    ? bundledThumbnailReady || cacheEntry?.phase === "ready"
      ? strings.vrmThumbnailAlt.replace("{name}", displayName)
      : strings.vrmThumbnailUnavailable
    : undefined;
  return (
    <div
      ref={containerRef}
      className={detail ? "vrm-thumbnail-preview" : undefined}
      role="img"
      aria-label={accessibleLabel}
      aria-hidden={detail ? undefined : "true"}
      style={{
        width: size,
        height: size,
        flex: "0 0 auto",
        display: "grid",
        placeItems: "center",
        overflow: "hidden",
        border: `1px ${candidate?.valid ? "solid" : "dashed"} ${COLORS.borderSubtle}`,
        borderRadius: RADIUS.sm,
        background: COLORS.bgInput,
        color: COLORS.fgDimmer,
      }}
    >
      {bundledThumbnailReady ? (
        <img
          src={DEFAULT_VRM_THUMBNAIL_URL}
          alt=""
          aria-hidden="true"
          draggable={false}
          decoding="async"
          onError={() => setBundledThumbnailFailed(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "50% 20%" }}
        />
      ) : cacheEntry?.phase === "ready" ? (
        <img
          src={cacheEntry.url}
          alt=""
          aria-hidden="true"
          draggable={false}
          decoding="async"
          style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "50% 20%" }}
        />
      ) : (
        <User size={detail ? 40 : 20} aria-hidden="true" />
      )}
    </div>
  );
}

function VrmCandidateDetail({
  candidate,
  onOpenExternal,
  strings,
}: {
  readonly candidate: VrmCandidate | undefined;
  readonly onOpenExternal: (url: string) => Promise<void>;
  readonly strings: UiStrings;
}): React.JSX.Element {
  if (!candidate) {
    return <div style={{ color: COLORS.fgDim }}>{strings.vrmNoMatches}</div>;
  }
  if (candidate.kind === "missing") {
    return (
      <div role="alert" style={{ color: COLORS.statusError, overflowWrap: "anywhere" }}>
        {strings.vrmMissingActive}
        <br />
        {candidate.path}
      </div>
    );
  }
  if (!candidate.valid || (candidate.kind === "file" && !candidate.meta)) {
    return (
      <div role="alert" style={{ color: COLORS.statusError, overflowWrap: "anywhere" }}>
        {candidate.invalidReason ?? strings.vrmApplyDisabledInvalid}
      </div>
    );
  }

  if (candidate.kind === "yori") {
    return (
      <>
        <h3 style={{ margin: 0, fontSize: FONT.sizeS }}>{strings.vrmSummaryHeading}</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: SPACING.xs }}>
          <VrmSummaryRow
            label={strings.vrmWhoMayUse}
            value={strings.vrmYoriUseWithinApp}
            mark="✓"
          />
          <VrmSummaryRow
            label={strings.vrmCommercialUsage}
            value={strings.vrmNotSpecified}
            mark="—"
          />
          <VrmSummaryRow label={strings.vrmModification} value={strings.vrmNotSpecified} mark="—" />
          <VrmSummaryRow
            label={strings.vrmRedistribution}
            value={strings.vrmYoriStandaloneReuse}
            mark="×"
          />
          <VrmSummaryRow label={strings.vrmCredit} value={strings.vrmYoriAuthor} mark="•" />
          <VrmSummaryRow
            label={strings.vrmContentRestrictions}
            value={
              <VrmRestrictionList
                strings={strings}
                groups={[
                  {
                    label: strings.vrmRestrictionsBlocked,
                    items: [strings.vrmRestrictionSexual],
                    tone: COLORS.statusError,
                  },
                  {
                    label: strings.vrmRestrictionsAllowed,
                    items: [strings.vrmRestrictionViolence],
                    tone: COLORS.fg,
                  },
                ]}
              />
            }
            mark="×"
          />
        </div>
        <p style={{ margin: `${SPACING.sm} 0 0`, color: COLORS.fgDimmer, fontSize: FONT.sizeXs }}>
          {strings.vrmCatalogIntro}
        </p>
        <details style={{ marginTop: SPACING.md }}>
          <summary style={{ color: COLORS.accent, cursor: "pointer" }}>
            {strings.vrmMoreDetails}
          </summary>
          <div style={{ marginTop: SPACING.sm, color: COLORS.fgDim }}>
            <VrmDetailRow label={strings.vrmAuthors} value={strings.vrmYoriAuthor} />
            <ul style={{ margin: `${SPACING.sm} 0 0`, paddingLeft: SPACING.xl }}>
              {yoriVrmDetails(strings).terms.map((term) => (
                <li key={term} style={{ marginBottom: SPACING.xs }}>
                  {term}
                </li>
              ))}
            </ul>
          </div>
        </details>
      </>
    );
  }

  const meta = candidate.meta;
  if (!meta) {
    return <div style={{ color: COLORS.statusError }}>{strings.vrmApplyDisabledInvalid}</div>;
  }
  const whoMayUse = meta.specVersion.startsWith("0") ? meta.allowedUser : meta.avatarPermission;
  const detailedUsage: readonly [string, VrmMetaValue][] = [
    [strings.vrmAllowedUser, meta.allowedUser],
    [strings.vrmAvatarPermission, meta.avatarPermission],
    [strings.vrmViolentUsage, meta.violentUsage],
    [strings.vrmSexualUsage, meta.sexualUsage],
    [strings.vrmCommercialUsage, meta.commercialUsage],
    [strings.vrmPoliticalUsage, meta.politicalOrReligiousUsage],
    [strings.vrmAntisocialUsage, meta.antisocialOrHateUsage],
    [strings.vrmRedistribution, meta.redistribution],
    [strings.vrmModification, meta.modification],
    [strings.vrmCredit, meta.creditNotation],
  ];
  return (
    <>
      <h3 style={{ margin: 0, fontSize: FONT.sizeS }}>{strings.vrmSummaryHeading}</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: SPACING.xs }}>
        <VrmSummaryRow
          label={strings.vrmWhoMayUse}
          value={formatVrmMetaValue(whoMayUse, strings)}
          mark={vrmSummaryMark(whoMayUse)}
        />
        <VrmSummaryRow
          label={strings.vrmCommercialUsage}
          value={formatVrmMetaValue(meta.commercialUsage, strings)}
          mark={vrmSummaryMark(meta.commercialUsage)}
        />
        <VrmSummaryRow
          label={strings.vrmModification}
          value={formatVrmMetaValue(meta.modification, strings)}
          mark={vrmSummaryMark(meta.modification)}
        />
        <VrmSummaryRow
          label={strings.vrmRedistribution}
          value={formatVrmMetaValue(meta.redistribution, strings)}
          mark={vrmSummaryMark(meta.redistribution)}
        />
        <VrmSummaryRow
          label={strings.vrmCredit}
          value={formatVrmMetaValue(meta.creditNotation, strings)}
          mark={vrmSummaryMark(meta.creditNotation)}
        />
        <VrmSummaryRow
          label={strings.vrmContentRestrictions}
          value={
            <VrmRestrictionList
              groups={summarizeVrmRestrictions(meta, strings)}
              strings={strings}
            />
          }
          mark="•"
        />
      </div>
      <p style={{ margin: `${SPACING.sm} 0 0`, color: COLORS.fgDimmer, fontSize: FONT.sizeXs }}>
        {strings.vrmCatalogIntro}
      </p>
      <details style={{ marginTop: SPACING.md }}>
        <summary style={{ color: COLORS.accent, cursor: "pointer" }}>
          {strings.vrmMoreDetails}
        </summary>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: SPACING.xs,
            marginTop: SPACING.sm,
          }}
        >
          <VrmDetailRow label={strings.vrmSpec} value={formatVrmSpecVersion(meta, strings)} />
          <VrmDetailRow label={strings.vrmName} value={meta.name ?? strings.vrmNotSpecified} />
          <VrmDetailRow
            label={strings.vrmVersion}
            value={meta.version ?? strings.vrmNotSpecified}
          />
          {meta.exporterVersion ? (
            <VrmDetailRow label={strings.vrmExporterVersion} value={meta.exporterVersion} />
          ) : null}
          <VrmDetailRow
            label={strings.vrmAuthors}
            value={meta.authors.join(", ") || strings.vrmNotSpecified}
          />
          <VrmDetailRow
            label={strings.vrmContact}
            value={meta.contactInformation ?? strings.vrmNotSpecified}
          />
          <VrmDetailRow
            label={strings.vrmReferences}
            value={
              meta.references.length ? (
                <VrmExternalLinks values={meta.references} onOpenExternal={onOpenExternal} />
              ) : (
                strings.vrmNotSpecified
              )
            }
          />
          <VrmDetailRow
            label={strings.vrmLicenseName}
            value={meta.license.name ?? strings.vrmNotSpecified}
          />
          <VrmDetailRow
            label={strings.vrmLicenseUrls}
            value={
              meta.license.urls.length ? (
                <VrmExternalLinks values={meta.license.urls} onOpenExternal={onOpenExternal} />
              ) : (
                strings.vrmNotSpecified
              )
            }
          />
          <VrmDetailRow
            label={strings.vrmThirdPartyLicenses}
            value={meta.license.thirdPartyLicenses ?? strings.vrmNotSpecified}
          />
          <h4 style={{ margin: `${SPACING.sm} 0 0`, fontSize: FONT.sizeS }}>
            {strings.vrmUsageConditions}
          </h4>
          {detailedUsage.map(([label, value]) => (
            <VrmDetailRow key={label} label={label} value={formatVrmMetaValue(value, strings)} />
          ))}
        </div>
      </details>
    </>
  );
}

interface VrmChooserDialogProps {
  readonly candidates: readonly VrmCandidate[];
  readonly selectedId: string;
  readonly activeName: string;
  readonly phase: "loading" | "ready" | "error";
  readonly loadError: string | null;
  readonly importError: string | null;
  readonly importNotice: boolean;
  readonly catalogNotice: string | null;
  readonly removeError: string | null;
  readonly importing: boolean;
  readonly removing: boolean;
  readonly onSelect: (id: string) => void;
  readonly onImport: () => void;
  readonly onRetryLoad: () => void;
  readonly onRetryImport: () => void;
  readonly onOpenExternal: (url: string) => Promise<void>;
  readonly onRemove: (candidate: VrmCandidate) => Promise<boolean>;
  readonly onApply: () => void;
  readonly onClose: () => void;
  readonly strings: UiStrings;
}

function VrmChooserDialog({
  candidates,
  selectedId,
  activeName,
  phase,
  loadError,
  importError,
  importNotice,
  catalogNotice,
  removeError,
  importing,
  removing,
  onSelect,
  onImport,
  onRetryLoad,
  onRetryImport,
  onOpenExternal,
  onRemove,
  onApply,
  onClose,
  strings,
}: VrmChooserDialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null);
  const removeCancelRef = useRef<HTMLButtonElement>(null);
  const removeConfirmRef = useRef<HTMLButtonElement>(null);
  const thumbnailCache = useVrmThumbnailCache();
  const [query, setQuery] = useState("");
  const [visibleLimit, setVisibleLimit] = useState(20);
  const [removeTargetId, setRemoveTargetId] = useState<string | null>(null);
  const sorted = sortVrmCandidates(candidates);
  const filtered = filterVrmCandidates(sorted, query);
  const selected = candidates.find((candidate) => candidate.id === selectedId) ?? candidates[0];
  const filteredSelectedIndex = filtered.findIndex((candidate) => candidate.id === selected?.id);
  const effectiveVisibleLimit = Math.max(
    visibleLimit,
    filteredSelectedIndex >= 0 ? Math.ceil((filteredSelectedIndex + 1) / 20) * 20 : 20,
  );
  const visible = filtered.slice(0, effectiveVisibleLimit);
  const selectedIndex = visible.findIndex((candidate) => candidate.id === selected?.id);
  const selectedName = selected ? vrmCandidateDisplayName(selected) : strings.vrmNoMatches;
  const selectedCreators = selected
    ? selected.kind === "yori"
      ? strings.vrmYoriAuthor
      : selected.meta?.authors.join(", ") || strings.vrmNotSpecified
    : strings.vrmNotSpecified;
  const removeTarget = candidates.find((candidate) => candidate.id === removeTargetId);
  const applyDisabled =
    phase !== "ready" || !selected?.valid || selected.kind === "missing" || selected.active;
  const disabledReason =
    phase !== "ready"
      ? strings.loading
      : selected?.kind === "missing"
        ? strings.vrmApplyDisabledMissing
        : selected?.active
          ? strings.vrmApplyDisabledActive
          : !selected?.valid
            ? strings.vrmApplyDisabledInvalid
            : null;
  const footerStatus =
    disabledReason ??
    strings.vrmPendingSwitch.replace("{from}", activeName).replace("{to}", selectedName);

  const selectAt = (index: number) => {
    const bounded = Math.max(0, Math.min(index, visible.length - 1));
    const candidate = visible[bounded];
    if (!candidate) return;
    onSelect(candidate.id);
    window.setTimeout(() => {
      [...(dialogRef.current?.querySelectorAll<HTMLElement>("[data-vrm-id]") ?? [])]
        .find((element) => element.dataset.vrmId === candidate.id)
        ?.focus();
    }, 0);
  };

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const preferred =
        candidates.length >= 8
          ? dialogRef.current?.querySelector<HTMLElement>("[data-vrm-search]")
          : dialogRef.current?.querySelector<HTMLElement>("[aria-selected='true']");
      (preferred ?? dialogRef.current)?.focus();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [candidates.length]);

  useEffect(() => {
    if (!removeTarget) return;
    const timeout = window.setTimeout(() => removeCancelRef.current?.focus(), 0);
    return () => window.clearTimeout(timeout);
  }, [removeTarget]);

  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (removeTarget && event.key === "Escape") {
      event.preventDefault();
      setRemoveTargetId(null);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...(dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex='-1'])",
      ) ?? []),
    ].filter((element) => element.offsetParent !== null || element === document.activeElement);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return (
    <div
      className="vrm-chooser-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: SPACING.sm,
        background: COLORS.overlayBackdrop,
      }}
    >
      <style>{`
        .vrm-chooser-dialog :is(button, input, summary):focus-visible { outline: 2px solid ${COLORS.accent}; outline-offset: 2px; }
        .vrm-chooser-body { grid-template-columns: ${SIZE.vrmListColumn} minmax(0, 1fr); }
        .vrm-chooser-footer { grid-template-columns: minmax(0, 1fr) auto auto; }
        @media (max-width: 639px), (max-height: 479px) {
          .vrm-chooser-dialog { width: calc(100vw - 16px) !important; height: calc(100vh - 16px) !important; }
          .vrm-chooser-body { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(132px, 40%) minmax(0, 1fr); }
          .vrm-chooser-list { border-right: 0 !important; border-bottom: 1px solid ${COLORS.borderSubtle}; }
          .vrm-chooser-footer { grid-template-columns: minmax(0, 1fr) auto; }
          .vrm-chooser-footer-status { grid-column: 1 / -1; }
          .vrm-thumbnail-preview { width: ${SIZE.vrmThumbnailPreviewCompact} !important; height: ${SIZE.vrmThumbnailPreviewCompact} !important; }
          .vrm-detail-header { grid-template-columns: ${SIZE.vrmThumbnailPreviewCompact} minmax(0, 1fr) !important; min-height: 72px !important; }
        }
      `}</style>
      <div
        ref={dialogRef}
        className="vrm-chooser-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vrm-dialog-title"
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
        style={{
          width: `min(92vw, ${SIZE.vrmDialogMaxWidth})`,
          height: `min(88vh, ${SIZE.vrmDialogMaxHeight})`,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          color: COLORS.fg,
          background: COLORS.bgPanel,
          border: `1px solid ${COLORS.borderMid}`,
          borderRadius: RADIUS.lg,
          boxShadow: "0 24px 80px rgba(0, 0, 0, 0.48)",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            minHeight: "44px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: `0 ${SPACING.md} 0 ${SPACING.lg}`,
            borderBottom: `1px solid ${COLORS.borderSubtle}`,
          }}
        >
          <h2 id="vrm-dialog-title" style={{ margin: 0, fontSize: FONT.sizeL }}>
            {strings.vrmDialogTitle}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={strings.vrmCloseDialog}
            style={{
              width: SIZE.targetMin,
              height: SIZE.targetMin,
              border: 0,
              borderRadius: RADIUS.sm,
              background: "transparent",
              color: COLORS.fgDim,
              font: "inherit",
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </header>

        <div className="vrm-chooser-body" style={{ display: "grid", minHeight: 0, flex: 1 }}>
          <div
            className="vrm-chooser-list"
            style={{
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              borderRight: `1px solid ${COLORS.borderSubtle}`,
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: SPACING.sm,
                padding: SPACING.md,
                borderBottom: `1px solid ${COLORS.borderSubtle}`,
              }}
            >
              {candidates.length >= 8 ? (
                <label style={{ position: "relative", display: "block" }}>
                  <Search
                    size={13}
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      left: "10px",
                      top: "50%",
                      transform: "translateY(-50%)",
                      color: COLORS.fgDimmer,
                    }}
                  />
                  <input
                    data-vrm-search
                    type="search"
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setVisibleLimit(20);
                    }}
                    placeholder={strings.vrmSearchPlaceholder}
                    aria-label={strings.vrmSearchPlaceholder}
                    style={{
                      width: "100%",
                      height: "34px",
                      padding: "0 10px 0 30px",
                      border: `1px solid ${COLORS.borderSubtle}`,
                      borderRadius: RADIUS.sm,
                      color: COLORS.fg,
                      background: COLORS.bgInput,
                      font: "inherit",
                    }}
                  />
                </label>
              ) : null}
              <button
                type="button"
                onClick={onImport}
                disabled={importing}
                style={{
                  minHeight: SIZE.targetMin,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: SPACING.xs,
                  border: `1px solid ${COLORS.borderSubtle}`,
                  borderRadius: RADIUS.sm,
                  background: COLORS.bgInput,
                  color: COLORS.accent,
                  font: "inherit",
                  cursor: importing ? "wait" : "pointer",
                  opacity: importing ? 0.6 : 1,
                }}
              >
                <Plus size={14} aria-hidden="true" />
                {importing ? strings.loading : strings.vrmImportNew}
              </button>
              {importNotice ? (
                <div aria-live="polite" style={{ color: COLORS.fgDim, fontSize: FONT.sizeXs }}>
                  {strings.vrmImportedNotApplied}
                </div>
              ) : null}
              {catalogNotice ? (
                <div role="status" style={{ color: COLORS.fg, fontSize: FONT.sizeXs }}>
                  {catalogNotice}
                </div>
              ) : null}
              {importError ? (
                <div role="alert" style={{ color: COLORS.statusError, fontSize: FONT.sizeXs }}>
                  {strings.vrmImportFailed}
                  <button
                    type="button"
                    onClick={onRetryImport}
                    style={{
                      marginLeft: SPACING.xs,
                      border: 0,
                      padding: 0,
                      background: "transparent",
                      color: COLORS.accent,
                      font: "inherit",
                      textDecoration: "underline",
                      cursor: "pointer",
                    }}
                  >
                    {strings.vrmRetry}
                  </button>
                </div>
              ) : null}
              {removeError ? (
                <div role="alert" style={{ color: COLORS.statusError, fontSize: FONT.sizeXs }}>
                  {strings.vrmRemoveFailed} {removeError}
                </div>
              ) : null}
            </div>

            {phase === "loading" && candidates.length <= 1 ? (
              <div style={{ padding: SPACING.md, color: COLORS.fgDim }}>{strings.loading}</div>
            ) : phase === "error" ? (
              <div role="alert" style={{ padding: SPACING.md, color: COLORS.statusError }}>
                {strings.vrmLoadingFailed} {loadError}
                <button
                  type="button"
                  onClick={onRetryLoad}
                  style={{
                    marginLeft: SPACING.sm,
                    border: 0,
                    background: "transparent",
                    color: COLORS.accent,
                    font: "inherit",
                    textDecoration: "underline",
                    cursor: "pointer",
                  }}
                >
                  {strings.vrmRetry}
                </button>
              </div>
            ) : (
              <div
                role="listbox"
                aria-label={strings.vrmChooseAvatar}
                onScroll={(event) => {
                  const list = event.currentTarget;
                  if (
                    visible.length < filtered.length &&
                    list.scrollHeight - list.scrollTop - list.clientHeight < 160
                  ) {
                    setVisibleLimit((current) => Math.min(filtered.length, current + 20));
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    selectAt(selectedIndex < 0 ? 0 : selectedIndex + 1);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    selectAt(selectedIndex < 0 ? 0 : selectedIndex - 1);
                  } else if (event.key === "Home") {
                    event.preventDefault();
                    selectAt(0);
                  } else if (event.key === "End") {
                    event.preventDefault();
                    selectAt(visible.length - 1);
                  }
                }}
                style={{
                  minHeight: 0,
                  display: "flex",
                  flex: 1,
                  flexDirection: "column",
                  gap: SPACING.xs,
                  overflowY: "auto",
                  padding: SPACING.sm,
                }}
              >
                {visible.length === 0 ? (
                  <div style={{ padding: SPACING.sm, color: COLORS.fgDim }}>
                    {strings.vrmNoMatches}
                  </div>
                ) : null}
                {visible.map((candidate) => {
                  const primary = vrmCandidateDisplayName(candidate);
                  const secondary = primary !== candidate.label ? candidate.label : null;
                  const isSelected = candidate.id === selected?.id;
                  return (
                    <button
                      key={candidate.id}
                      data-vrm-id={candidate.id}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      tabIndex={isSelected ? 0 : -1}
                      onClick={() => onSelect(candidate.id)}
                      style={{
                        position: "relative",
                        minHeight: "48px",
                        display: "grid",
                        gridTemplateColumns: `${SIZE.vrmThumbnailList} minmax(0, 1fr) auto`,
                        alignItems: "center",
                        gap: SPACING.xs,
                        padding: `${SPACING.xs} ${SPACING.sm} ${SPACING.xs} ${SPACING.md}`,
                        border: `1px solid ${isSelected ? COLORS.accentBorder : "transparent"}`,
                        borderRadius: RADIUS.sm,
                        background: isSelected ? COLORS.accentSoft : "transparent",
                        color: COLORS.fg,
                        font: "inherit",
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                    >
                      {isSelected ? (
                        <span
                          aria-hidden="true"
                          style={{
                            position: "absolute",
                            top: "5px",
                            bottom: "5px",
                            left: 0,
                            width: "3px",
                            borderRadius: "0 2px 2px 0",
                            background: COLORS.accent,
                          }}
                        />
                      ) : null}
                      <VrmThumbnail
                        candidate={candidate}
                        cache={thumbnailCache}
                        strings={strings}
                      />
                      <span style={{ minWidth: 0 }}>
                        <span
                          style={{
                            display: "block",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            fontWeight: isSelected ? FONT.weightSemibold : FONT.weightNormal,
                          }}
                          title={primary}
                        >
                          {candidate.active ? "● " : ""}
                          {primary}
                        </span>
                        {secondary ? (
                          <span
                            style={{
                              display: "block",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              color: COLORS.fgDim,
                              fontSize: FONT.sizeXs,
                            }}
                            title={secondary}
                          >
                            {secondary}
                          </span>
                        ) : null}
                      </span>
                      {candidate.active ? (
                        <span
                          style={{
                            padding: "2px 5px",
                            borderRadius: "999px",
                            background: COLORS.accentSoft,
                            color: COLORS.accent,
                            fontSize: FONT.sizeXs,
                          }}
                        >
                          {strings.vrmActive}
                        </span>
                      ) : candidate.kind === "yori" ? (
                        <span
                          aria-hidden="true"
                          style={{ color: COLORS.fgDim, fontSize: FONT.sizeXs }}
                        >
                          {strings.vrmBundledAvatar}
                        </span>
                      ) : !candidate.valid ? (
                        <span style={{ color: COLORS.statusError, fontSize: FONT.sizeXs }}>
                          {candidate.kind === "missing"
                            ? strings.vrmMissingBadge
                            : strings.vrmInvalid}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <section style={{ minHeight: 0, display: "flex", flexDirection: "column" }}>
            <header
              className="vrm-detail-header"
              style={{
                minHeight: "112px",
                display: "grid",
                gridTemplateColumns: `${SIZE.vrmThumbnailPreview} minmax(0, 1fr)`,
                alignItems: "start",
                gap: SPACING.md,
                padding: `${SPACING.sm} ${SPACING.lg}`,
                borderBottom: `1px solid ${COLORS.borderSubtle}`,
              }}
            >
              <VrmThumbnail
                candidate={selected}
                cache={thumbnailCache}
                priority
                detail
                strings={strings}
              />
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: SPACING.sm,
                  }}
                >
                  <div
                    style={{ minWidth: 0, display: "flex", alignItems: "center", gap: SPACING.sm }}
                  >
                    <h3 style={{ margin: 0, fontSize: FONT.sizeM, overflowWrap: "anywhere" }}>
                      {selectedName}
                    </h3>
                    {selected?.active ? (
                      <span style={{ color: COLORS.accent, fontSize: FONT.sizeXs }}>
                        {strings.vrmActive}
                      </span>
                    ) : null}
                  </div>
                  {selected?.kind === "file" && !selected.active ? (
                    <button
                      type="button"
                      onClick={() => setRemoveTargetId(selected.id)}
                      disabled={removing}
                      style={{
                        minHeight: SIZE.targetMin,
                        flex: "0 0 auto",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: SPACING.xs,
                        padding: `0 ${SPACING.sm}`,
                        border: `1px solid ${COLORS.borderSubtle}`,
                        borderRadius: RADIUS.sm,
                        background: "transparent",
                        color: COLORS.fgDim,
                        font: "inherit",
                        fontSize: FONT.sizeXs,
                        cursor: removing ? "wait" : "pointer",
                      }}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                      {strings.vrmRemove}
                    </button>
                  ) : null}
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: SPACING.xs,
                    marginTop: "3px",
                    fontSize: FONT.sizeS,
                  }}
                >
                  <span style={{ color: COLORS.fgDimmer, fontSize: FONT.sizeXs }}>
                    {strings.vrmCreator}
                  </span>
                  <span style={{ color: COLORS.fg, fontWeight: FONT.weightSemibold }}>
                    {selectedCreators}
                  </span>
                </div>
                {selected?.meta ? (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: SPACING.xs,
                      marginTop: "2px",
                      fontSize: FONT.sizeS,
                    }}
                  >
                    <span style={{ color: COLORS.fgDimmer, fontSize: FONT.sizeXs }}>VRM</span>
                    <span style={{ color: COLORS.fg }}>
                      {formatVrmSpecVersion(selected.meta, strings)}
                    </span>
                  </div>
                ) : null}
                {selected?.kind === "yori" ? (
                  <div style={{ marginTop: "2px", color: COLORS.fgDim, fontSize: FONT.sizeXs }}>
                    {strings.vrmBundledAvatar}
                  </div>
                ) : null}
              </div>
            </header>
            <div
              style={{
                minHeight: 0,
                flex: 1,
                overflowY: "auto",
                padding: SPACING.lg,
                fontSize: FONT.sizeS,
              }}
            >
              <VrmCandidateDetail
                candidate={selected}
                onOpenExternal={onOpenExternal}
                strings={strings}
              />
            </div>
          </section>
        </div>

        <footer
          className="vrm-chooser-footer"
          style={{
            minHeight: "56px",
            display: "grid",
            alignItems: "center",
            gap: SPACING.sm,
            padding: `${SPACING.sm} ${SPACING.md}`,
            borderTop: `1px solid ${COLORS.borderSubtle}`,
          }}
        >
          <div
            className="vrm-chooser-footer-status"
            aria-live="polite"
            style={{ minWidth: 0, color: disabledReason ? COLORS.fgDim : COLORS.fg }}
          >
            {footerStatus}
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              minWidth: "96px",
              minHeight: SIZE.targetMin,
              border: `1px solid ${COLORS.borderSubtle}`,
              borderRadius: RADIUS.sm,
              background: "transparent",
              color: COLORS.fg,
              font: "inherit",
              cursor: "pointer",
            }}
          >
            {strings.vrmCancel}
          </button>
          <button
            type="button"
            onClick={onApply}
            disabled={applyDisabled}
            style={{
              minWidth: "172px",
              minHeight: "40px",
              border: `1px solid ${COLORS.accentBorder}`,
              borderRadius: RADIUS.sm,
              background: COLORS.accent,
              color: COLORS.bgPanel,
              font: "inherit",
              fontWeight: FONT.weightSemibold,
              cursor: applyDisabled ? "not-allowed" : "pointer",
              opacity: applyDisabled ? 0.45 : 1,
            }}
          >
            {strings.vrmApply}
          </button>
        </footer>
      </div>
      {removeTarget ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 1,
            display: "grid",
            placeItems: "center",
            padding: SPACING.md,
            background: COLORS.overlayBackdrop,
          }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="vrm-remove-title"
            aria-describedby="vrm-remove-body"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !removing) {
                event.preventDefault();
                setRemoveTargetId(null);
              } else if (event.key === "Tab") {
                const first = removeCancelRef.current;
                const last = removeConfirmRef.current;
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first?.focus();
                }
              }
            }}
            style={{
              width: "min(92vw, 420px)",
              padding: SPACING.lg,
              border: `1px solid ${COLORS.borderMid}`,
              borderRadius: RADIUS.lg,
              background: COLORS.bgPanel,
              boxShadow: "0 18px 52px rgba(0, 0, 0, 0.52)",
            }}
          >
            <h3 id="vrm-remove-title" style={{ margin: 0, fontSize: FONT.sizeM }}>
              {strings.vrmRemoveConfirmTitle}
            </h3>
            <p id="vrm-remove-body" style={{ margin: `${SPACING.sm} 0 ${SPACING.lg}` }}>
              {strings.vrmRemoveConfirmBody.replace(
                "{name}",
                vrmCandidateDisplayName(removeTarget),
              )}
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: SPACING.sm }}>
              <button
                ref={removeCancelRef}
                type="button"
                onClick={() => setRemoveTargetId(null)}
                disabled={removing}
                style={{
                  minWidth: "88px",
                  minHeight: SIZE.targetMin,
                  border: `1px solid ${COLORS.borderSubtle}`,
                  borderRadius: RADIUS.sm,
                  background: "transparent",
                  color: COLORS.fg,
                  font: "inherit",
                  cursor: removing ? "default" : "pointer",
                }}
              >
                {strings.vrmCancel}
              </button>
              <button
                ref={removeConfirmRef}
                type="button"
                onClick={() => {
                  void onRemove(removeTarget).then((removed) => {
                    if (removed) setRemoveTargetId(null);
                  });
                }}
                disabled={removing}
                style={{
                  minWidth: "88px",
                  minHeight: SIZE.targetMin,
                  border: `1px solid ${COLORS.statusError}`,
                  borderRadius: RADIUS.sm,
                  background: COLORS.statusError,
                  color: COLORS.bgPanel,
                  font: "inherit",
                  fontWeight: FONT.weightSemibold,
                  cursor: removing ? "wait" : "pointer",
                  opacity: removing ? 0.6 : 1,
                }}
              >
                {removing ? strings.loading : strings.vrmRemoveConfirm}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function Panel({ ctx }: { ctx: UiContext }): React.JSX.Element {
  const [creditsOpen, setCreditsOpen] = useState(false);
  const [activeVrmPath, setActiveVrmPath] = useState<string | null>(() =>
    localStorage.getItem("yorishiro:vrm"),
  );
  const [vrmCatalogOpen, setVrmCatalogOpen] = useState(false);
  const [vrmCatalog, setVrmCatalog] = useState<
    | { readonly phase: "idle" | "loading" }
    | { readonly phase: "ready"; readonly entries: readonly VrmAvatarEntry[] }
    | { readonly phase: "error"; readonly reason: string }
  >({ phase: "idle" });
  const vrmEntriesRef = useRef<readonly VrmAvatarEntry[]>([]);
  const vrmTriggerRef = useRef<HTMLButtonElement>(null);
  const [selectedVrmId, setSelectedVrmId] = useState<string>(YORI_VRM_ID);
  const [vrmImporting, setVrmImporting] = useState(false);
  const [vrmImportError, setVrmImportError] = useState<string | null>(null);
  const [vrmImportNotice, setVrmImportNotice] = useState(false);
  const [vrmCatalogNotice, setVrmCatalogNotice] = useState<VrmCatalogNotice | null>(null);
  const [vrmRemoving, setVrmRemoving] = useState(false);
  const [vrmRemoveError, setVrmRemoveError] = useState<string | null>(null);
  const lastVrmImportPath = useRef<string | null>(null);
  const [persona, setPersona] = useState<string | null>(null);
  const [scene, setScene] = useState<string | null>(null);
  const [agent, setAgent] = useState<string>("claude");
  // defaultProfile が agent を固定しているときの profile id。null なら dropdown は通常操作可能。
  const [agentPinnedBy, setAgentPinnedBy] = useState<string | null>(null);
  // 環境音 mute は config が読まれるまで undecided。getConfig 後に boolean を入れる。
  const [ambientMuted, setAmbientMuted] = useState<boolean | null>(null);
  // 環境音ボリューム（0.0-1.0）。config 読み込み前は null。
  const [ambientVolume, setAmbientVolume] = useState<number | null>(null);
  // Voice Summary / voice clip / GPT Live 共通ボリューム（0.0-1.0）。
  const [voiceVolume, setVoiceVolume] = useState<number | null>(null);
  const voiceVolumeBeforeMuteRef = useRef(1);
  const voiceVolumeChangeSeq = useRef(0);
  // idle motion の大きさ（0.0-3.0）。config 読み込み前は null。
  const [motionIntensity, setMotionIntensity] = useState<number | null>(null);
  // activeAmbientUi（Aura toggle 等の状態管理用）。
  const [activeAmbientUi, setActiveAmbientUiLocal] = useState<readonly string[]>([]);
  const [attentionLightNotifications, setAttentionLightNotifications] = useState<boolean | null>(
    null,
  );
  const [language, setLanguage] = useState<AppLanguage>("auto");
  const [resolvedLanguage, setResolvedLanguage] = useState<ResolvedLanguage>("en");
  // 言語切り替えは連打できるため、古い async completion で表示 state を戻さない。
  const languageChangeSeq = useRef(0);
  const [voiceFrequency, setVoiceFrequency] = useState<"on" | "off">("on");
  const [pendingNewSessionChange, setPendingNewSessionChange] =
    useState<PendingNewSessionChange | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  // in-app update。設定を開いたときに一度だけ確認し、更新があればバナーを出す。
  // idle = 更新なし（確認前・確認失敗を含む）。downloading の ratio は 0-1 / null（不定）。
  const [updateState, setUpdateState] = useState<
    | { phase: "idle" }
    | { phase: "available"; update: AvailableUpdate }
    | { phase: "downloading"; ratio: number | null }
    | { phase: "error" }
  >({ phase: "idle" });
  const personas = ctx.app.listPersonas();
  const visiblePersonas = filterPersonaOptionsForLanguage(personas, resolvedLanguage);
  const personaSelectValue = configLoaded
    ? resolvePersonaSelectValue(persona, resolvedLanguage)
    : "";
  const scenes = ctx.app.listScenes();
  const sceneSelectValue = configLoaded ? resolveSceneSelectValue(scene) : "";
  const strings = getStrings(resolvedLanguage);
  const vrmCatalogNoticeMessage = vrmCatalogNotice
    ? (vrmCatalogNotice.kind === "removed"
        ? strings.vrmRemoved
        : strings.vrmMissingRemoved
      ).replace("{name}", vrmCatalogNotice.name)
    : null;
  const vrmEntries = vrmCatalog.phase === "ready" ? vrmCatalog.entries : vrmEntriesRef.current;
  const vrmCandidates = resolveVrmCandidates(vrmEntries, activeVrmPath);
  const displayedVrmName =
    vrmCandidates.find((candidate) => candidate.active)?.label ?? DEFAULT_VRM_NAME;
  const requestNewSessionChange = (change: PendingNewSessionChange) => {
    setPendingNewSessionChange(change);
  };
  const confirmPendingNewSessionChange = () => {
    const pending = pendingNewSessionChange;
    setPendingNewSessionChange(null);
    pending?.run();
  };
  const newSessionConfirmContent = pendingNewSessionChange
    ? resolveNewSessionConfirm(strings, pendingNewSessionChange)
    : null;

  const loadVrmCatalog = useCallback(
    async (preferredPath?: string | null) => {
      setVrmCatalog({ phase: "loading" });
      try {
        const entries = await invoke<VrmAvatarEntry[]>("list_vrm_avatars");
        vrmEntriesRef.current = entries;
        setVrmCatalog({ phase: "ready", entries });
        const activePath = localStorage.getItem("yorishiro:vrm");
        const activeEntryExists =
          activePath === null || entries.some((entry) => entry.path === activePath);
        const resolvedActivePath = activeEntryExists ? activePath : null;
        if (activePath !== null && !activeEntryExists) {
          const missingName = activePath.split(/[\\/]/).pop() || activePath;
          ctx.app.setVrm(null);
          setActiveVrmPath(null);
          setVrmCatalogNotice({ kind: "missing", name: missingName });
        }
        const candidates = resolveVrmCandidates(entries, resolvedActivePath);
        const preferred =
          preferredPath === undefined
            ? candidates.find((candidate) => candidate.active)
            : candidates.find((candidate) => candidate.path === preferredPath);
        setSelectedVrmId(preferred?.id ?? activeVrmCandidateId(candidates));
        return entries;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        setVrmCatalog({ phase: "error", reason });
        return null;
      }
    },
    [ctx.app],
  );

  useEffect(() => {
    void loadVrmCatalog();
  }, [loadVrmCatalog]);

  useEffect(() => {
    let aborted = false;
    void ctx.app.getConfig().then((cur) => {
      if (aborted) return;
      setPersona(cur.primaryPersona);
      setScene(cur.activeScene);
      // dropdown は実起動 agent を表示する。defaultProfile が固定していれば操作不可。
      setAgent(cur.effectiveAgent);
      setAgentPinnedBy(cur.agentPinnedByProfile);
      setAmbientMuted(cur.ambientAudioMuted);
      setAmbientVolume(cur.ambientAudioVolume);
      const loadedVoiceVolume = cur.voiceVolume ?? 1;
      setVoiceVolume(loadedVoiceVolume);
      if (loadedVoiceVolume > 0) voiceVolumeBeforeMuteRef.current = loadedVoiceVolume;
      setMotionIntensity(cur.motionIntensity);
      setActiveAmbientUiLocal(cur.activeAmbientUi);
      setAttentionLightNotifications(cur.attentionLightNotifications);
      setLanguage(cur.language);
      setResolvedLanguage(cur.resolvedLanguage);
      setVoiceFrequency(cur.voiceFrequency ?? "on");
      setConfigLoaded(true);
    });
    return () => {
      aborted = true;
    };
  }, [ctx]);

  useEffect(() => {
    let aborted = false;
    void checkForUpdate().then((update) => {
      if (!aborted && update) setUpdateState({ phase: "available", update });
    });
    return () => {
      aborted = true;
    };
  }, []);

  /** 更新バナーの1ボタン。ダウンロード・適用して relaunch する（成功時は戻ってこない）。 */
  const onInstallUpdate = useCallback((update: AvailableUpdate) => {
    setUpdateState({ phase: "downloading", ratio: null });
    update
      .installAndRelaunch((ratio) => {
        setUpdateState({ phase: "downloading", ratio });
      })
      .catch(() => {
        setUpdateState({ phase: "error" });
      });
  }, []);

  // ダイアログ本文用の persona 表示名。localizedYoriPersonaId 等の解決済み id を渡す。
  const personaLabelById = (id: string): string => {
    const pack = personas.find((p) => p.id === id);
    return pack ? formatPackOptionLabel(pack) : id;
  };

  const onPersonaChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedId = e.target.value;
    const next = configPrimaryPersonaForSelection(selectedId);
    if (next === persona) return;
    requestNewSessionChange({
      kind: "persona",
      nextLabel: personaLabelById(selectedId),
      run: () => {
        void applyConfigUpdate({
          next,
          prev: persona,
          setLocal: setPersona,
          write: (v) => ctx.app.setPrimaryPersona(v),
          emitEvent: (n, p) => ctx.emitEvent(n, p),
          field: "primaryPersona",
        });
      },
    });
  };

  const onSceneChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = configActiveSceneForSelection(e.target.value);
    void applyConfigUpdate({
      next,
      prev: scene,
      setLocal: setScene,
      write: (v) => ctx.app.setActiveScene(v),
      emitEvent: (n, p) => ctx.emitEvent(n, p),
      field: "activeScene",
    });
  };

  const onAgentChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value;
    if (next === agent) return;
    requestNewSessionChange({
      kind: "agent",
      currentLabel: terminalAgentLabel(agent),
      nextLabel: terminalAgentLabel(next),
      run: () => {
        void applyConfigUpdate({
          next,
          prev: agent,
          setLocal: setAgent,
          write: (v) => ctx.app.setTerminalAgent(v),
          emitEvent: (n, p) => ctx.emitEvent(n, p),
          field: "terminalAgent",
        });
      },
    });
  };

  const onLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value as AppLanguage;
    const seq = languageChangeSeq.current + 1;
    languageChangeSeq.current = seq;
    const prevPersona = persona;
    const prevResolvedLanguage = resolvedLanguage;
    const nextResolvedLanguage = resolveLanguage(next, getBrowserLocales());
    void applyConfigUpdate({
      next,
      prev: language,
      setLocal: (v) => {
        if (seq !== languageChangeSeq.current) return;
        setLanguage(v);
        setResolvedLanguage(v === language ? prevResolvedLanguage : nextResolvedLanguage);
        if (v === language) setPersona(prevPersona);
      },
      write: async (v) => {
        await ctx.app.setLanguage(v);
        const cur = await ctx.app.getConfig();
        if (seq !== languageChangeSeq.current) return;
        setLanguage(cur.language);
        setPersona(cur.primaryPersona);
        setResolvedLanguage(cur.resolvedLanguage);
      },
      emitEvent: (n, p) => ctx.emitEvent(n, p),
      field: "language",
    });
  };

  const onVoiceToggle = () => {
    const next: "on" | "off" = voiceFrequency === "on" ? "off" : "on";
    requestNewSessionChange({
      kind: "voice",
      run: () => {
        void applyConfigUpdate({
          next,
          prev: voiceFrequency,
          setLocal: setVoiceFrequency,
          write: (v) => ctx.app.setVoiceFrequency(v),
          emitEvent: (n, p) => ctx.emitEvent(n, p),
          field: "voiceFrequency",
        });
      },
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

  const onAttentionLightToggle = () => {
    if (attentionLightNotifications === null) return;
    void applyConfigUpdate({
      next: !attentionLightNotifications,
      prev: attentionLightNotifications,
      setLocal: setAttentionLightNotifications,
      write: (enabled) => ctx.app.setAttentionLightNotifications(enabled),
      emitEvent: (n, p) => ctx.emitEvent(n, p),
      field: "attentionLightNotifications",
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

  const applyVoiceVolumeChange = (next: number) => {
    if (voiceVolume === null) return;
    const seq = ++voiceVolumeChangeSeq.current;
    void applyConfigUpdate({
      next,
      prev: voiceVolume,
      setLocal: (value) => {
        setVoiceVolume(value);
        if (value > 0) voiceVolumeBeforeMuteRef.current = value;
      },
      write: (v) => ctx.app.setVoiceVolume(v),
      emitEvent: (n, p) => ctx.emitEvent(n, p),
      field: "voiceVolume",
      shouldRollback: () => seq === voiceVolumeChangeSeq.current,
      readRollbackValue: async () => (await ctx.app.getConfig()).voiceVolume,
    });
  };

  const onVoiceVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    applyVoiceVolumeChange(Number.parseFloat(e.target.value));
  };

  const onVoiceMutedToggle = () => {
    if (voiceVolume === null) return;
    const next = resolveVoiceMuteToggle(voiceVolume, voiceVolumeBeforeMuteRef.current);
    voiceVolumeBeforeMuteRef.current = next.restoreVolume;
    applyVoiceVolumeChange(next.nextVolume);
  };

  const onMotionIntensityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (motionIntensity === null) return;
    const next = Number.parseFloat(e.target.value);
    void applyConfigUpdate({
      next,
      prev: motionIntensity,
      setLocal: setMotionIntensity,
      write: (v) => ctx.app.setMotionIntensity(v),
      emitEvent: (n, p) => ctx.emitEvent(n, p),
      field: "motionIntensity",
    });
  };

  const importVrmPath = async (sourcePath: string) => {
    setVrmImporting(true);
    setVrmImportError(null);
    setVrmImportNotice(false);
    try {
      const dest = await invoke<string>("import_vrm", { src: sourcePath });
      await loadVrmCatalog(dest);
      setVrmCatalogOpen(true);
      setVrmImportNotice(true);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error("[yorishiro-settings] vrm load failed:", reason);
      setVrmImportError(reason);
      ctx.emitEvent("yorishiro-settings:write-failed", { field: "vrm", reason });
    } finally {
      setVrmImporting(false);
    }
  };

  const onImportVrm = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      title: strings.selectVrmFile,
      filters: [{ name: "VRM", extensions: ["vrm"] }],
    });
    if (!selected) return;
    lastVrmImportPath.current = selected as string;
    await importVrmPath(selected as string);
  };

  const retryLastVrmImport = () => {
    const path = lastVrmImportPath.current;
    if (path) void importVrmPath(path);
  };

  const onRemoveVrm = async (candidate: VrmCandidate): Promise<boolean> => {
    if (candidate.kind !== "file" || candidate.active || candidate.sourceId === null) return false;
    const ordered = sortVrmCandidates(vrmCandidates);
    const index = ordered.findIndex((entry) => entry.id === candidate.id);
    const fallback =
      ordered.slice(index + 1).find((entry) => entry.id !== candidate.id) ??
      [...ordered.slice(0, Math.max(index, 0))]
        .reverse()
        .find((entry) => entry.id !== candidate.id);
    setVrmRemoving(true);
    setVrmRemoveError(null);
    try {
      const removed = await invoke<boolean>("remove_vrm_avatar", { id: candidate.sourceId });
      await loadVrmCatalog(fallback?.path ?? null);
      const name = vrmCandidateDisplayName(candidate);
      setVrmCatalogNotice({ kind: removed ? "removed" : "missing", name });
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setVrmRemoveError(reason);
      ctx.emitEvent("yorishiro-settings:write-failed", { field: "vrm", reason });
      return false;
    } finally {
      setVrmRemoving(false);
    }
  };

  const openVrmDialog = () => {
    setSelectedVrmId(activeVrmCandidateId(vrmCandidates));
    setVrmImportNotice(false);
    setVrmImportError(null);
    setVrmRemoveError(null);
    setVrmCatalogOpen(true);
  };

  const closeVrmDialog = () => {
    setSelectedVrmId(activeVrmCandidateId(vrmCandidates));
    setVrmCatalogOpen(false);
    window.setTimeout(() => vrmTriggerRef.current?.focus(), 0);
  };

  const onApplyVrm = () => {
    const selected = vrmCandidates.find((candidate) => candidate.id === selectedVrmId);
    if (!selected || !applyVrmCandidate(selected, ctx.app.setVrm)) return;
    setActiveVrmPath(selected.path);
    setVrmCatalogOpen(false);
    window.setTimeout(() => vrmTriggerRef.current?.focus(), 0);
  };

  /** 設定パネルを閉じる共通 helper。 */
  const fireCloseRequest = () => {
    const saved = ctx.state.get(PREVIOUS_ACTIVE_UI_KEY);
    const savedStr = typeof saved === "string" ? saved : null;
    const target = savedStr === SETTINGS_PACK_ID ? null : savedStr;
    window.dispatchEvent(
      new CustomEvent("yorishiro-settings:close-requested", {
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
      ctx.emitEvent("yorishiro-settings:write-failed", {
        field: `fixed-prompt-${key}`,
        reason,
      });
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        top: "var(--title-bar-height, 32px)",
        left: "var(--sidebar-width)",
        width: "calc(100% - var(--sidebar-width))",
        height: "calc(100vh - var(--title-bar-height, 32px))",
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
        {/* 更新バナー: 更新があるときだけ現れる控えめな1行。1ボタンで適用して再起動する */}
        {updateState.phase !== "idle" && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: SPACING.md,
              marginBottom: SPACING.lg,
              padding: `${SPACING.sm} ${SPACING.md}`,
              borderRadius: RADIUS.sm,
              background: COLORS.accentSoft,
              border: `1px solid ${COLORS.accentBorder}`,
              fontSize: FONT.sizeXs,
            }}
          >
            {updateState.phase === "available" && (
              <>
                <span style={{ opacity: 0.85 }}>
                  {strings.updateAvailable.replace("{version}", updateState.update.version)}
                </span>
                <button
                  type="button"
                  onClick={() => onInstallUpdate(updateState.update)}
                  style={{
                    background: "none",
                    border: "none",
                    color: COLORS.accent,
                    font: "inherit",
                    fontSize: "inherit",
                    cursor: "pointer",
                    padding: 0,
                    textDecoration: "underline",
                    textDecorationColor: "currentColor",
                    textUnderlineOffset: "2px",
                  }}
                >
                  {strings.updateAndRestart}
                </button>
              </>
            )}
            {updateState.phase === "downloading" && (
              <span style={{ opacity: 0.85 }}>
                {strings.updateDownloading}
                {updateState.ratio !== null && ` ${Math.round(updateState.ratio * 100)}%`}
              </span>
            )}
            {updateState.phase === "error" && (
              <span style={{ opacity: 0.7 }}>{strings.updateFailed}</span>
            )}
          </div>
        )}

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
          {/* Credits は他 action の右に並べる。fixed-prompt ではなく overlay を開く別系統。 */}
          <button
            type="button"
            onClick={() => setCreditsOpen(true)}
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
            {strings.labelCredits}
          </button>
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
            <div
              title={displayedVrmName}
              style={{
                minWidth: 0,
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: COLORS.fgDim,
              }}
            >
              {strings.vrmCurrent}: {displayedVrmName}
            </div>
            <button
              ref={vrmTriggerRef}
              type="button"
              onClick={openVrmDialog}
              aria-haspopup="dialog"
              style={{
                background: COLORS.bgInput,
                minHeight: SIZE.targetMin,
                padding: `0 ${SPACING.md}`,
                borderRadius: RADIUS.sm,
                border: `1px solid ${COLORS.borderSubtle}`,
                cursor: "pointer",
                color: COLORS.fg,
                font: "inherit",
                fontFamily: FONT.family,
                fontSize: FONT.sizeS,
              }}
            >
              {strings.vrmChange}
            </button>
          </div>
          {vrmCatalogNoticeMessage ? (
            <div
              role="status"
              style={{
                gridColumn: "2",
                marginTop: `-${SPACING.xs}`,
                color: COLORS.fgDim,
                fontSize: FONT.sizeXs,
              }}
            >
              {vrmCatalogNoticeMessage}
            </div>
          ) : null}

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
              value={sceneSelectValue}
              onChange={onSceneChange}
              loadingPlaceholder={!configLoaded ? strings.loading : undefined}
              emptyLabel={strings.noPacks}
              options={scenes.map((s) => ({
                value: s.id,
                label: s.name ?? s.id,
              }))}
            />
          </div>

          {/* Motion Intensity */}
          <div style={{ opacity: 0.7 }}>{strings.motionIntensity}</div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: SPACING.xs,
              width: "100%",
              minWidth: "280px",
              maxWidth: "360px",
            }}
          >
            <input
              type="range"
              min="0"
              max="3"
              step="0.05"
              value={motionIntensity ?? 1}
              onChange={onMotionIntensityChange}
              disabled={motionIntensity === null}
              aria-label={strings.motionIntensity}
              style={{
                flex: 1,
                height: "4px",
                appearance: "none",
                WebkitAppearance: "none",
                background: COLORS.borderSubtle,
                borderRadius: "2px",
                outline: "none",
                cursor: motionIntensity === null ? "default" : "pointer",
                accentColor: COLORS.accent,
              }}
            />
            <div
              style={{
                position: "relative",
                height: "13px",
                fontSize: "10px",
                lineHeight: 1.2,
                opacity: 0.5,
              }}
            >
              {[
                { key: "calm", label: strings.motionLevelCalm },
                { key: "normal", label: strings.motionLevelNormal },
                { key: "lively", label: strings.motionLevelLively },
                { key: "over", label: strings.motionLevelOver },
              ].map((level, index) => (
                <span key={level.key} style={motionLevelLabelStyle(index)}>
                  {level.label}
                </span>
              ))}
            </div>
          </div>

          {/* Aura */}
          <div style={{ opacity: 0.7, ...separatedToggleRowStyle }}>{strings.labelAura}</div>
          <div style={separatedToggleRowStyle}>
            <Toggle checked={auraEnabled} onChange={onAuraToggle} />
          </div>

          {/* Light alert */}
          <div style={{ opacity: 0.7, ...separatedToggleRowStyle }}>
            {strings.labelAttentionLight}
          </div>
          <div style={separatedToggleRowStyle}>
            <Toggle
              checked={attentionLightNotifications ?? true}
              disabled={attentionLightNotifications === null}
              onChange={onAttentionLightToggle}
            />
          </div>
        </div>

        {/* 24px gap */}
        <div style={{ height: "24px" }} />

        {/* グループ 2: Ambient / Voice volume（mute icon + volume slider） */}
        <div style={gridStyle}>
          <div style={{ opacity: 0.7 }}>{strings.ambientVolume}</div>
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

        <div style={{ ...gridStyle, marginTop: SPACING.md }}>
          <div style={{ opacity: 0.7 }}>{strings.voiceVolume}</div>
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
              muted={(voiceVolume ?? 1) === 0}
              disabled={voiceVolume === null}
              onToggle={onVoiceMutedToggle}
              labels={{ mute: strings.muteVoice, unmute: strings.unmuteVoice }}
            />
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={voiceVolume ?? 1}
              onChange={onVoiceVolumeChange}
              disabled={voiceVolume === null}
              aria-label={strings.voiceVolume}
              style={{
                flex: 1,
                height: "4px",
                appearance: "none",
                WebkitAppearance: "none",
                background: COLORS.borderSubtle,
                borderRadius: "2px",
                outline: "none",
                cursor: voiceVolume === null ? "default" : "pointer",
                accentColor: COLORS.accent,
              }}
            />
          </div>
        </div>

        {/* Voice Summary。再起動の告知は確認ダイアログが担う。 */}
        <div style={{ ...gridStyle, marginTop: SPACING.md }}>
          <div style={{ opacity: 0.7 }}>{strings.voiceFrequency}</div>
          <div>
            <Toggle checked={voiceFrequency === "on"} onChange={onVoiceToggle} />
          </div>
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
              options={TERMINAL_AGENT_OPTIONS}
              disabled={agentPinnedBy !== null}
            />
          </div>
        </div>
        {/* 再起動の告知は確認ダイアログが担う。注記は defaultProfile 固定時のみ。 */}
        {agentPinnedBy !== null ? (
          <div
            style={{
              marginTop: SPACING.xs,
              marginLeft: `calc(${GRID_LABEL_COLUMN_WIDTH} + ${SPACING.md})`,
              fontSize: FONT.sizeXs,
              opacity: 0.5,
            }}
          >
            {`${strings.agentControlledByProfile}（${agentPinnedBy}）`}
          </div>
        ) : null}

        {/* 32px gap */}
        <div style={{ height: "32px" }} />

        <HealthDiagnostics ctx={ctx} strings={strings} />

        {/* 32px gap */}
        <div style={{ height: "32px" }} />

        <SnapshotRestoreSection ctx={ctx} locale={resolvedLanguage} strings={strings} />

        {/* 32px gap */}
        <div style={{ height: "32px" }} />

        <PackWorkbench ctx={ctx} strings={strings} onClose={fireCloseRequest} />
      </main>

      {creditsOpen && <CreditsOverlay ctx={ctx} onBack={() => setCreditsOpen(false)} />}
      {vrmCatalogOpen ? (
        <VrmChooserDialog
          candidates={vrmCandidates}
          selectedId={selectedVrmId}
          activeName={displayedVrmName}
          phase={vrmCatalog.phase === "idle" ? "loading" : vrmCatalog.phase}
          loadError={vrmCatalog.phase === "error" ? vrmCatalog.reason : null}
          importError={vrmImportError}
          importNotice={vrmImportNotice}
          catalogNotice={vrmCatalogNoticeMessage}
          removeError={vrmRemoveError}
          importing={vrmImporting}
          removing={vrmRemoving}
          onSelect={(id) => {
            setSelectedVrmId(id);
            setVrmImportNotice(false);
          }}
          onImport={() => void onImportVrm()}
          onRetryLoad={() => void loadVrmCatalog()}
          onRetryImport={retryLastVrmImport}
          onOpenExternal={(url) => ctx.app.openExternal(url)}
          onRemove={onRemoveVrm}
          onApply={onApplyVrm}
          onClose={closeVrmDialog}
          strings={strings}
        />
      ) : null}
      {newSessionConfirmContent ? (
        <NewSessionConfirmDialog
          message={newSessionConfirmContent.message}
          cancelLabel={strings.restoreConfirmCancel}
          confirmLabel={newSessionConfirmContent.confirmLabel}
          onCancel={() => setPendingNewSessionChange(null)}
          onConfirm={confirmPendingNewSessionChange}
        />
      ) : null}
    </div>
  );
}

const settingsPack: UiPackDefinition = {
  id: SETTINGS_PACK_ID,
  type: "ui",
  layout: {
    sidebar: {},
    character: { visible: true },
    presence: { target: "shell" },
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

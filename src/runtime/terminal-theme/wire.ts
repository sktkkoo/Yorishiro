/**
 * `initTerminalTheme` — TerminalRuntime のカラーテーマを ScenePackRegistry に bind する
 * lifecycle helper。
 *
 * Boot 時に一度呼び、registry の active scene 変化を購読する。Subscriber は
 * CSS variables と「新規/再表示 terminal が読む現在テーマ」を更新する。
 * scene が terminal を宣言していない場合は DEFAULT_TERMINAL_THEME に
 * フォールバックする。
 */

import type { SceneSpec, UiTheme } from "../../sdk/scene";
import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import type { Disposable, ScenePackRegistry } from "../scene-pack-registry";
import type { TerminalRuntime } from "../terminal-runtime";
import { DEFAULT_TERMINAL_THEME } from "../terminal-runtime";

// ---------------------------------------------------------------------------
// UI テーマ — CSS カスタムプロパティへの適用
// ---------------------------------------------------------------------------

const DEFAULT_UI_THEME: Required<UiTheme> = {
  background: "#141619",
  foreground: "#e8ebe7",
  foregroundDim: "rgba(232, 235, 231, 0.55)",
  sidebarBackground: "#0e0f11",
  panelBackground: "rgba(20, 22, 25, 0.96)",
  border: "rgba(120, 134, 124, 0.28)",
  buttonBackground: "#24282b",
  buttonForeground: "#aab4ac",
  inputBackground: "rgba(255, 255, 255, 0.04)",
  accent: "rgba(142, 176, 156, 1)",
  accentSoft: "rgba(142, 176, 156, 0.08)",
  accentBorder: "rgba(142, 176, 156, 0.25)",
  muted: "#56615b",
  glow: "rgba(142, 176, 156, 0.06)",
};

/** UiTheme の各 field を CSS カスタムプロパティ名にマッピング */
const UI_THEME_CSS_MAP: Record<keyof UiTheme, string> = {
  background: "--yorishiro-bg",
  foreground: "--yorishiro-fg",
  foregroundDim: "--yorishiro-fg-dim",
  sidebarBackground: "--yorishiro-sidebar-bg",
  panelBackground: "--yorishiro-panel-bg",
  border: "--yorishiro-border",
  buttonBackground: "--yorishiro-button-bg",
  buttonForeground: "--yorishiro-button-fg",
  inputBackground: "--yorishiro-input-bg",
  accent: "--yorishiro-accent",
  accentSoft: "--yorishiro-accent-soft",
  accentBorder: "--yorishiro-accent-border",
  muted: "--yorishiro-muted",
  glow: "--yorishiro-glow",
};

/**
 * UI テーマを `:root` の CSS カスタムプロパティに反映する。
 * scene.ui が undefined の場合は DEFAULT_UI_THEME にフォールバック。
 */
function applyUiTheme(ui: UiTheme | undefined): void {
  const resolved = { ...DEFAULT_UI_THEME, ...ui };
  const root = document.documentElement;
  for (const key of Object.keys(UI_THEME_CSS_MAP) as Array<keyof UiTheme>) {
    root.style.setProperty(UI_THEME_CSS_MAP[key], resolved[key]);
  }
}

export interface InitTerminalThemeResult {
  readonly dispose: () => void;
}

type ResolvedTerminalTheme = Parameters<TerminalRuntime["setTheme"]>[0];

interface TerminalThemeState {
  currentTerminalTheme: ResolvedTerminalTheme;
}

function getTerminalThemeState(): TerminalThemeState {
  return getOrInit(KEYS.TERMINAL_THEME_STATE, () => ({
    currentTerminalTheme: { ...DEFAULT_TERMINAL_THEME },
  }));
}

/**
 * scene.terminal は partial theme なので、毎回 default に merge してから適用する。
 * これにより、前 scene の未指定 color が次 scene に残らない。
 */
export function resolveTerminalTheme(scene: SceneSpec | null): ResolvedTerminalTheme {
  return { ...DEFAULT_TERMINAL_THEME, ...(scene?.terminal ?? {}) };
}

/** 現在適用中のターミナルテーマ。新タブ表示時に適用するために保持する。 */
export function syncCurrentTerminalTheme(scene: SceneSpec | null): ResolvedTerminalTheme {
  const theme = resolveTerminalTheme(scene);
  getTerminalThemeState().currentTerminalTheme = theme;
  applyUiTheme(scene?.ui);
  return theme;
}

/**
 * 現在のターミナルテーマを返す。Terminal コンポーネントが visible になった時に
 * 呼んで setTheme に渡す用途。
 */
export function getCurrentTerminalTheme(): ResolvedTerminalTheme {
  return getTerminalThemeState().currentTerminalTheme;
}

/**
 * ScenePackRegistry の active scene 変化を購読し、CSS vars と currentTerminalTheme
 * を更新する。TerminalRuntime への setTheme は呼ばない — terminal.tsx の visible
 * effect と App.tsx の scene subscription が個別に適用する。
 */
export function initTerminalTheme(registry: ScenePackRegistry): InitTerminalThemeResult {
  const apply = (scene: SceneSpec | null): void => {
    syncCurrentTerminalTheme(scene);
  };

  const sub: Disposable = registry.subscribeActive(apply);
  return { dispose: () => sub.dispose() };
}

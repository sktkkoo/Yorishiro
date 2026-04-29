/**
 * `initTerminalTheme` — TerminalRuntime のカラーテーマを ScenePackRegistry に bind する
 * lifecycle helper。
 *
 * Boot 時に一度呼び、registry の active scene 変化を購読する。Subscriber は
 * SceneSpec の `terminal` field を `setTheme` に渡す。scene が terminal を
 * 宣言していない場合は DEFAULT_TERMINAL_THEME にフォールバックする。
 */

import type { SceneSpec, UiTheme } from "../../sdk/scene";
import type { Disposable, ScenePackRegistry } from "../scene-pack-registry";
import type { TerminalRuntime } from "../terminal-runtime";
import { DEFAULT_TERMINAL_THEME } from "../terminal-runtime";

// ---------------------------------------------------------------------------
// UI テーマ — CSS カスタムプロパティへの適用
// ---------------------------------------------------------------------------

const DEFAULT_UI_THEME: Required<UiTheme> = {
  background: "#0f1923",
  foreground: "#eceff4",
  foregroundDim: "rgba(236, 239, 244, 0.55)",
  sidebarBackground: "#0a1118",
  panelBackground: "rgba(14, 23, 34, 0.96)",
  border: "rgba(59, 80, 104, 0.5)",
  buttonBackground: "#243447",
  buttonForeground: "#a8b8cc",
  inputBackground: "rgba(255, 255, 255, 0.04)",
  accent: "rgba(77, 217, 207, 1)",
  accentSoft: "rgba(77, 217, 207, 0.08)",
  accentBorder: "rgba(77, 217, 207, 0.25)",
  muted: "#3b5068",
  glow: "rgba(77, 217, 207, 0.06)",
};

/** UiTheme の各 field を CSS カスタムプロパティ名にマッピング */
const UI_THEME_CSS_MAP: Record<keyof UiTheme, string> = {
  background: "--charminal-bg",
  foreground: "--charminal-fg",
  foregroundDim: "--charminal-fg-dim",
  sidebarBackground: "--charminal-sidebar-bg",
  panelBackground: "--charminal-panel-bg",
  border: "--charminal-border",
  buttonBackground: "--charminal-button-bg",
  buttonForeground: "--charminal-button-fg",
  inputBackground: "--charminal-input-bg",
  accent: "--charminal-accent",
  accentSoft: "--charminal-accent-soft",
  accentBorder: "--charminal-accent-border",
  muted: "--charminal-muted",
  glow: "--charminal-glow",
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

export function initTerminalTheme(
  registry: ScenePackRegistry,
  terminal: TerminalRuntime,
): InitTerminalThemeResult {
  const apply = (scene: SceneSpec | null): void => {
    terminal.setTheme(scene?.terminal ?? DEFAULT_TERMINAL_THEME);
    applyUiTheme(scene?.ui);
  };

  const sub: Disposable = registry.subscribeActive(apply);
  return { dispose: () => sub.dispose() };
}

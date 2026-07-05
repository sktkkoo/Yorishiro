/**
 * 設定画面の semantic design tokens。
 *
 * 「decision を name に固定する」layer。inline rgba を散らすかわりに、
 * 用途を示す名前を介して値を参照する。将来 theme 切替を入れる時はこの file
 * の COLORS / SPACING など 1 set を別 set に差し替えるだけで全 component に伝播する。
 *
 * 設計：semantic 1 層のみ（primitive 層は palette が増えてから検討）。
 * Yorishiro scale ではこの層だけで十分。
 */

/**
 * scene テーマの CSS 変数を参照する。scene 切替で自動的に色が変わる。
 */
const THEME = {
  bgPanel: "var(--yorishiro-panel-bg)",
  bgInput: "var(--yorishiro-input-bg)",
  bgInputHover: "var(--yorishiro-input-bg)",
  bgButton: "var(--yorishiro-button-bg)",
  bgButtonHover: "var(--yorishiro-button-bg)",
  accent: "var(--yorishiro-accent)",
  accentSoft: "var(--yorishiro-accent-soft)",
  accentSoftHover: "var(--yorishiro-accent-soft)",
  accentBorder: "var(--yorishiro-accent-border)",
  accentBorderHover: "var(--yorishiro-accent-border)",
  fg: "var(--yorishiro-fg)",
  fgDim: "var(--yorishiro-fg-dim)",
  fgDimmer: "var(--yorishiro-muted)",
  fgDimmest: "var(--yorishiro-muted)",
  borderSubtle: "var(--yorishiro-border)",
  borderMid: "var(--yorishiro-border)",
} as const;

export const COLORS = {
  ...THEME,
  statusError: "#ff756f",
  statusWarning: "#d6b15c",
} as const;

export const SPACING = {
  xs: "4px",
  sm: "8px",
  md: "12px",
  lg: "16px",
  xl: "20px",
  xxl: "28px",
} as const;

export const RADIUS = {
  sm: "4px",
  md: "6px",
  lg: "8px",
} as const;

export const FONT = {
  family: "monospace",
  sizeXs: "11px",
  sizeS: "12px",
  sizeM: "13px",
  sizeL: "14px",
  weightNormal: 400,
  weightSemibold: 600,
} as const;

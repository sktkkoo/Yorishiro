/**
 * 設定画面の semantic design tokens。
 *
 * 「decision を name に固定する」layer。inline rgba を散らすかわりに、
 * 用途を示す名前を介して値を参照する。将来 theme 切替を入れる時はこの file
 * の COLORS / SPACING など 1 set を別 set に差し替えるだけで全 component に伝播する。
 *
 * 設計：semantic 1 層のみ（primitive 層は palette が増えてから検討）。
 * Charminal scale ではこの層だけで十分。
 */

const DARK = {
  // surface
  bgPanel: "rgba(14, 23, 34, 0.96)",
  bgInput: "rgba(255, 255, 255, 0.04)",
  bgInputHover: "rgba(255, 255, 255, 0.06)",
  bgButton: "rgba(255, 255, 255, 0.08)",
  bgButtonHover: "rgba(255, 255, 255, 0.14)",

  // accent (Charminal teal)
  accent: "rgba(77, 217, 207, 1)",
  accentSoft: "rgba(77, 217, 207, 0.08)",
  accentSoftHover: "rgba(77, 217, 207, 0.16)",
  accentBorder: "rgba(77, 217, 207, 0.25)",
  accentBorderHover: "rgba(77, 217, 207, 0.4)",

  // text
  fg: "#eceff4",
  fgDim: "rgba(236, 239, 244, 0.7)",
  fgDimmer: "rgba(236, 239, 244, 0.55)",
  fgDimmest: "rgba(236, 239, 244, 0.4)",

  // borders
  borderSubtle: "rgba(255, 255, 255, 0.08)",
  borderMid: "rgba(255, 255, 255, 0.14)",
} as const;

// 将来 LIGHT theme などを足したい場合はここに同 shape の set を並べ、
// `export const COLORS = isLight ? LIGHT : DARK;` のように切替える。
// 別スレッドで theme system を入れる時にこの export を変更点にする。
export const COLORS = DARK;

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

/**
 * 台帳へ入る自然文の sanitize。
 *
 * 台帳は「raw terminal log を voice 層へ流さない」境界そのものなので、
 * summary / note は必ずここを通し、escape sequence・制御文字を落として
 * 一行の短文に正規化する。
 */

/** ANSI escape sequence（CSI / OSC / single-char escape）。 */
const ANSI_PATTERN = new RegExp(
  [
    "\\u001b\\[[0-9;?]*[ -/]*[@-~]",
    "\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)",
    "\\u001b[@-_]",
  ].join("|"),
  "g",
);

/** 委任 work summary の上限長。 */
export const MAX_SUMMARY_LENGTH = 120;

/** 状態注記 note の上限長。 */
export const MAX_NOTE_LENGTH = 200;

/**
 * escape sequence・制御文字を除去し、連続空白を畳んで上限長に丸める。
 * 上限を超えた場合は末尾を "…" にする。結果が空文字なら情報が無かったと見なす。
 */
export function sanitizeHumanText(value: string, maxLength: number): string {
  const withoutAnsi = value.replace(ANSI_PATTERN, " ");
  const withoutControls = [...withoutAnsi]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? " " : character;
    })
    .join("");
  const collapsed = withoutControls.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}

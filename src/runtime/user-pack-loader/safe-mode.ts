/**
 * Safe-mode の判定 logic。
 *
 * user が `CHARMINAL_SAFE_MODE=1 open /Applications/Charminal.app` のように
 * 起動して、user pack layer が破損したときの rescue 経路として機能する。
 *
 * strict に `'1'` のみを true とする（曖昧な truthy 判定は避ける）。
 * 環境変数の取得自体は Rust 側 `is_safe_mode` command が担う。ここは
 * 取得された文字列値から bool を決める pure fn に留める。
 *
 * Philosophy: docs/philosophy/PHILOSOPHY.md「触れるものと、触れないもの」
 * Internal design-record: 2026-04-18-phase-1c-rescue-and-mcp.md Section 4.1
 */

export function isSafeMode(envValue: string | null | undefined): boolean {
  return envValue === "1";
}

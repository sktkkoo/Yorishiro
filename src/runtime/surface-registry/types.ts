/**
 * Surface registry — host が所有する「named surface → DOM mount node」の対応表。
 *
 * pack / UiLayout / MCP は surface を **名前で** 参照し、document.querySelector
 * への直依存を断つ。これにより「querySelector が null で黙って no-op」事故と
 * 「複数 writer が同一 DOM を奪い合う」競合を構造的に消す。
 *
 * P1 が登録する surface:
 *   - "shell"     : width / collapse を所有する縦カラム（P1 で .sidebar を包む .shell-column wrapper として導入）
 *   - "character" : Three/VRM/Scene viewport の mount node（.charactor-container）
 * 後続 phase で "chrome" / "terminal" を追加する。
 *
 * Internal design-record: specs/2026-05-18-shell-named-surfaces-design.md §1/§2
 */

export type SurfaceName = "shell" | "character";

export interface SurfaceRegistry {
  /** surface 名に DOM node を結び付ける。既存登録があれば置換する。 */
  register(name: SurfaceName, el: HTMLElement): void;
  /** 登録を外す。引数 el が現在の登録と一致する時のみ外す（stale unmount 競合回避）。 */
  unregister(name: SurfaceName, el: HTMLElement): void;
  /** 登録された DOM node を返す。未登録は null。 */
  get(name: SurfaceName): HTMLElement | null;
  /** 登録の有無。 */
  has(name: SurfaceName): boolean;
}

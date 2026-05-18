/**
 * Presence target resolver — host 所有の単一解決点。
 *
 * active UI pack が宣言した presence 契約（または active pack 無し時の host 既定 =
 * classic shell）から「AI の存在強度 / ui.sidebar.set 相当が mutate する surface」を
 * 引き、registry で DOM node に解決する。解決できなければ typed `unavailable`
 * （loud-unavailable, spec §4）を返す。`?? querySelector` の silent fallback を
 * 構造的に置換するための pure 関数（DOM 直依存なし、registry は注入）。
 *
 * Internal design-record: specs/2026-05-18-shell-named-surfaces-design.md §1/§2/§4
 */

import type { SurfaceName, SurfaceRegistry } from "../surface-registry/types";

/** UI pack が宣言する presence 契約。SDK UiLayout.presence と同形。 */
export interface PresenceDecl {
  readonly target: SurfaceName;
}

/**
 * classic シェルの host 既定 presence。active UI pack 無し時に使う。
 * P4 で default-shell bundled pack の宣言へ降格する（それまでは host が既定として保持）。
 */
export const HOST_DEFAULT_PRESENCE: PresenceDecl = { target: "shell" };

/** resolver への入力。active UI pack の有無を discriminated union で表現。 */
export type ActiveUiPresence =
  | { readonly kind: "none" }
  | {
      readonly kind: "pack";
      readonly id: string;
      readonly presence: PresenceDecl | undefined;
    };

/** presence surface 解決結果。ok=false が loud-unavailable（reason を AI に返す）。 */
export type PresenceResolution =
  | { readonly ok: true; readonly el: HTMLElement; readonly target: SurfaceName }
  | { readonly ok: false; readonly reason: string };

/**
 * active pack 宣言（または host 既定）から presence surface を解決する。
 *
 * - active pack 無し → host 既定（classic = shell）
 * - active pack あり & presence 宣言あり → 宣言 target
 * - active pack あり & presence 未宣言 → unavailable
 * - target が registry 未登録 → unavailable
 */
export function resolvePresence(
  active: ActiveUiPresence,
  registry: Pick<SurfaceRegistry, "get">,
): PresenceResolution {
  const decl: PresenceDecl | undefined =
    active.kind === "none" ? HOST_DEFAULT_PRESENCE : active.presence;
  if (decl === undefined) {
    const id = active.kind === "pack" ? active.id : "?";
    return {
      ok: false,
      reason: `active UI pack '${id}' declares no presence target`,
    };
  }
  const el = registry.get(decl.target);
  if (el === null) {
    return {
      ok: false,
      reason: `presence target surface '${decl.target}' is not registered`,
    };
  }
  return { ok: true, el, target: decl.target };
}

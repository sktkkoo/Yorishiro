/**
 * SingleActiveRegistry が共有する base 型。
 *
 * persona / scene の Pack origin と Disposable handle はこの type を再利用する。
 * 各 specialization（PersonaRegistry / ScenePackRegistry）の types.ts も
 * これを re-export して structural compatibility を保つ。
 */

export type PackOrigin = "bundled" | "user";

/**
 * SingleActiveRegistry が register できる entry の最低限の shape。
 *
 * 各 registry は (id, origin) に加えて domain 固有の field（PersonaEntry なら
 * `persona`, ScenePackEntry なら `scene`）を載せた型を渡す。base はそれらを
 * `extractValue` 経由で取り出すだけで shape は知らない。
 */
export interface SingleActiveEntry {
  readonly id: string;
  readonly origin: PackOrigin;
}

export interface Disposable {
  readonly dispose: () => void;
}

/**
 * SingleActiveRegistry の constructor option。
 */
export interface SingleActiveRegistryOptions<TEntry extends SingleActiveEntry, TValue> {
  /**
   * entry から外に export する value を取り出す。
   * PersonaEntry → PersonaDefinition、ScenePackEntry → SceneSpec のような mapping。
   *
   * reference 比較で listener fire を判定するため、**同じ entry には同じ value
   * object を返すこと**（毎回 spread して新 object を作らない）。
   */
  readonly extractValue: (entry: TEntry) => TValue;
  /** warning 出力に使う label。例：`"PersonaRegistry"` → `[PersonaRegistry] xxx`。 */
  readonly label: string;
  /** カスタム warning sink。default は `console.warn`。 */
  readonly warn?: (msg: string) => void;
  /**
   * active id が null のとき bundled fallback を選ばず、明示的に null を返す。
   * UI pack の「default = UI pack なし」のような domain で使う。default `false`。
   */
  readonly nullMeansNoActive?: boolean;
  /**
   * 異なる id の bundled が複数 register された時に warning を出すか。
   * dev mistake 検出に使う（同梱 pack を増やす際の名前衝突警告）。default `false`。
   */
  readonly warnOnMultipleBundled?: boolean;
}

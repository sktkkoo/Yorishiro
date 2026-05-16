/**
 * Provenance — registry に登録される全 entry に必須で付く「誰が登録したか」の tag。
 *
 * - builtin : Charminal 本体由来（const array、組込み handler 等）
 * - persona : persona pack 由来（packId で識別）
 * - system : システム由来（packId で識別）
 *
 * 用途は (1) revelation 3.14（amenity motion-free）等の不変量を型で強制する材料、
 * (2) UGC UI で「誰の実装か」を区別表示する根拠、(3) debug log の origin tag。
 */
export type Provenance =
  | { readonly source: "builtin" }
  | { readonly source: "persona"; readonly packId: string }
  | { readonly source: "system"; readonly packId: string };

/**
 * Module kind. Phase 1 では trigger-handler のみが consumer を持ち、残り 2 つは
 * Phase 3 で具体実装が追加される（型と registry surface は今 phase で固める）。
 */
export type ModuleKind = "trigger-handler" | "procedural-module" | "animation-provider";

/**
 * Provenance source × kind の許可関係。
 *
 * - builtin   : 全 kind 可（runtime 自身の組込み実装）
 * - persona   : trigger-handler / procedural-module / animation-provider（motion 全般）
 * - system    : trigger-handler のみ（motion 系は revelation 3.14 で禁じられている）
 *
 * 型レベルの enforcement は AllowedKindFor<Source> として表現し、register の signature
 * で `kind extends AllowedKindFor<Provenance["source"]>` を要求する形で使う。
 */
export type AllowedKindFor<S extends Provenance["source"]> = S extends "builtin"
  ? ModuleKind
  : S extends "persona"
    ? "trigger-handler" | "procedural-module" | "animation-provider"
    : S extends "system"
      ? "trigger-handler"
      : never;

/**
 * Runtime-level guard. The type system already prevents bad combinations at
 * compile time, but registry.register also asserts at runtime as a defense in
 * depth (e.g., for entries that arrive via dynamic pack loading).
 *
 * @returns true if the (kind, provenance) combination is allowed.
 */
export function isAllowed(kind: ModuleKind, provenance: Provenance): boolean {
  switch (provenance.source) {
    case "builtin":
      return true;
    case "persona":
      return (
        kind === "trigger-handler" || kind === "procedural-module" || kind === "animation-provider"
      );
    case "system":
      return kind === "trigger-handler";
  }
}

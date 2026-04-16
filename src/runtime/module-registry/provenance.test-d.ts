import type { AllowedKindFor, ModuleKind, Provenance } from "./provenance";

// ─── Type assertion utility ─────────────────────────────────────

type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

// `assertType<true>(value)` のように使い、value の型が true でなければ tsc が落ちる。
declare function assertType<T extends true>(value: T): void;

// ─── builtin: 全 kind を許可 ─────────────────────────────────────

assertType<Equals<AllowedKindFor<"builtin">, ModuleKind>>(true);

// ─── persona: 全 kind を許可（builtin と同じ集合になる）────────────

assertType<
  Equals<AllowedKindFor<"persona">, "trigger-handler" | "procedural-module" | "animation-provider">
>(true);

// ─── harness: trigger-handler のみ ───────────────────────────────

assertType<Equals<AllowedKindFor<"harness">, "trigger-handler">>(true);

// ─── 排他: harness は procedural-module を含まない ─────────────────

type HarnessAllowsProcedural = "procedural-module" extends AllowedKindFor<"harness"> ? true : false;
assertType<Equals<HarnessAllowsProcedural, false>>(true);

// ─── 排他: harness は animation-provider を含まない ───────────────

type HarnessAllowsAnimation = "animation-provider" extends AllowedKindFor<"harness"> ? true : false;
assertType<Equals<HarnessAllowsAnimation, false>>(true);

// ─── Provenance 構造の必須 field ─────────────────────────────────

declare const builtin: Provenance;
if (builtin.source === "persona") {
  // packId が必須であることの確認
  assertType<Equals<typeof builtin.packId, string>>(true);
}
if (builtin.source === "harness") {
  assertType<Equals<typeof builtin.packId, string>>(true);
}
if (builtin.source === "builtin") {
  // builtin には packId がない
  // @ts-expect-error — builtin variant has no packId
  void builtin.packId;
}

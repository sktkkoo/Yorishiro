import { assertType, type Equals } from "../../test-utils/type-assert";
import type { AllowedKindFor, ModuleKind, Provenance } from "./provenance";

// ─── builtin: 全 kind を許可 ─────────────────────────────────────

assertType<Equals<AllowedKindFor<"builtin">, ModuleKind>>(true);

// ─── persona: 全 kind を許可（builtin と同じ集合になる）────────────

assertType<
  Equals<AllowedKindFor<"persona">, "trigger-handler" | "procedural-module" | "animation-provider">
>(true);

// ─── system: trigger-handler のみ ───────────────────────────────

assertType<Equals<AllowedKindFor<"system">, "trigger-handler">>(true);

// ─── 排他: system は procedural-module を含まない ─────────────────

type SystemAllowsProcedural = "procedural-module" extends AllowedKindFor<"system"> ? true : false;
assertType<Equals<SystemAllowsProcedural, false>>(true);

// ─── 排他: system は animation-provider を含まない ───────────────

type SystemAllowsAnimation = "animation-provider" extends AllowedKindFor<"system"> ? true : false;
assertType<Equals<SystemAllowsAnimation, false>>(true);

// ─── Provenance 構造の必須 field ─────────────────────────────────

declare const builtin: Provenance;
if (builtin.source === "persona") {
  // packId が必須であることの確認
  assertType<Equals<typeof builtin.packId, string>>(true);
}
if (builtin.source === "system") {
  assertType<Equals<typeof builtin.packId, string>>(true);
}
if (builtin.source === "builtin") {
  // builtin には packId がない
  // @ts-expect-error — builtin variant has no packId
  void builtin.packId;
}

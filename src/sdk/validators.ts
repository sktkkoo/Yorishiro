/**
 * SDK runtime validators.
 *
 * Pack loader が load 時に pack の shape を runtime check するための関数群。
 * TypeScript の型は runtime で erase されるので、user が書いた pack（特に JS で
 * 書かれた、JSDoc も無いもの）を register する前にここで shape を保証する。
 *
 * 検査は top-level 構造のみ。深い nested field（個別 handler の signature など）は
 * 後段の register 処理で型付けされたまま扱うので、ここでは形だけ確かめる。
 *
 * SDK contract は公開された瞬間 stable。validator は user pack が古い / 新しい shape で来ても
 * 落ちる場所を明示的にするための safety net。
 */

import type {
  AmbientUiPackDefinition,
  AmenityPackDefinition,
  EffectDefinition,
  PersonaDefinition,
  UiPackDefinition,
} from "./index";
import type { ScenePackDefinition, ScenePackManifest } from "./scene-pack";

/** Pack の shape 違反で throw される error。loader 側で catch して dev-log に流す想定。 */
export class PackValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackValidationError";
  }
}

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const requireField = (
  value: Record<string, unknown>,
  field: string,
  typeGuard: (v: unknown) => boolean,
  typeName: string,
  context: string,
): void => {
  const v = value[field];
  if (!typeGuard(v)) {
    throw new PackValidationError(
      `${context}: field '${field}' must be ${typeName} (got ${typeof v})`,
    );
  }
};

/**
 * Validate an EffectDefinition shape. Returns the same value on success, throws
 * PackValidationError otherwise.
 */
export function validateEffectDefinition(pack: unknown): EffectDefinition {
  if (!isObject(pack)) {
    throw new PackValidationError(`EffectDefinition must be an object (got ${typeof pack})`);
  }
  const ctx = "EffectDefinition";
  requireField(pack, "id", (v) => typeof v === "string", "a string", ctx);
  requireField(pack, "type", (v) => v === "effect", '"effect"', ctx);
  requireField(pack, "run", (v) => typeof v === "function", "a function", ctx);
  return pack as unknown as EffectDefinition;
}

/**
 * Validate a UiPackDefinition shape. Returns the same value on success, throws
 * PackValidationError otherwise.
 */
export function validateUiPackDefinition(pack: unknown): UiPackDefinition {
  if (!isObject(pack)) {
    throw new PackValidationError(`UiPackDefinition must be an object (got ${typeof pack})`);
  }
  const ctx = "UiPackDefinition";
  requireField(pack, "id", (v) => typeof v === "string", "a string", ctx);
  requireField(pack, "type", (v) => v === "ui", '"ui"', ctx);
  requireField(pack, "layout", isObject, "an object", ctx);
  requireField(pack, "mount", (v) => typeof v === "function", "a function", ctx);
  return pack as unknown as UiPackDefinition;
}

/**
 * AmbientUiPackDefinition の shape を検証する。成功時は同じ値を返し、失敗時は
 * PackValidationError を throw する。
 *
 * 必須 field: `type === "ambient-ui"`、`id: string`、`mount: function`。
 * 余分な field は tolerant に無視する（user の将来拡張を壊さない）。
 */
export function validateAmbientUiPackDefinition(pack: unknown): AmbientUiPackDefinition {
  if (!isObject(pack)) {
    throw new PackValidationError(`AmbientUiPackDefinition must be an object (got ${typeof pack})`);
  }
  const ctx = "AmbientUiPackDefinition";
  requireField(pack, "id", (v) => typeof v === "string", "a string", ctx);
  requireField(pack, "type", (v) => v === "ambient-ui", '"ambient-ui"', ctx);
  requireField(pack, "mount", (v) => typeof v === "function", "a function", ctx);
  return pack as unknown as AmbientUiPackDefinition;
}

/**
 * AmenityPackDefinition の shape を検証する。
 * 必須 field: `id: string`、`name: string`、`activate: function`。
 */
export function validateAmenityDefinition(pack: unknown): AmenityPackDefinition {
  if (!isObject(pack)) {
    throw new PackValidationError(`AmenityPackDefinition must be an object (got ${typeof pack})`);
  }
  const ctx = "AmenityPackDefinition";
  requireField(pack, "id", (v) => typeof v === "string", "a string", ctx);
  requireField(pack, "name", (v) => typeof v === "string", "a string", ctx);
  requireField(pack, "activate", (v) => typeof v === "function", "a function", ctx);
  return pack as unknown as AmenityPackDefinition;
}

/**
 * Validate a PersonaDefinition shape. Returns the same value on success, throws
 * PackValidationError otherwise.
 */
export function validatePersonaDefinition(pack: unknown): PersonaDefinition {
  if (!isObject(pack)) {
    throw new PackValidationError(`PersonaDefinition must be an object (got ${typeof pack})`);
  }
  const ctx = "PersonaDefinition";
  requireField(pack, "id", (v) => typeof v === "string", "a string", ctx);
  requireField(pack, "name", (v) => typeof v === "string", "a string", ctx);
  // thinking / reflex はともに optional。
  // loader が persona.md から thinking を inject する経路、および minimal persona.js
  // （id + name だけ書いて他を省略）の経路のどちらもサポートするため。
  // 旧 world / logReading field（2026-07-18 に軸ごと削除）は余剰プロパティとして無視される。
  if (pack.thinking !== undefined) {
    requireField(pack, "thinking", isObject, "an object", ctx);
  }
  if (pack.reflex !== undefined) {
    requireField(pack, "reflex", isObject, "an object", ctx);
    const reflex = pack.reflex as Record<string, unknown>;
    if (!isObject(reflex.responses)) {
      throw new PackValidationError(
        `${ctx}: field 'reflex.responses' must be an object (got ${typeof reflex.responses})`,
      );
    }
  }
  return pack as unknown as PersonaDefinition;
}

/**
 * Scene pack の default export を shape 検証 + type narrow。
 * manifest は別 validator (`validateScenePackManifest`) で扱う。
 */
export function validateScenePackDefinition(rawDef: unknown): ScenePackDefinition {
  if (rawDef === null || typeof rawDef !== "object") {
    throw new PackValidationError("scene pack default export must be an object");
  }
  const d = rawDef as Record<string, unknown>;
  if (d.type !== "scene") {
    throw new PackValidationError(`scene pack type must be "scene", got "${d.type}"`);
  }
  if (typeof d.id !== "string") {
    throw new PackValidationError("scene pack must have string id");
  }
  if (typeof d.scene !== "object" || d.scene === null) {
    throw new PackValidationError("scene pack must have scene SceneSpec");
  }
  if (d.component !== undefined && typeof d.component !== "function") {
    throw new PackValidationError("scene pack component must be a React component function");
  }
  return d as unknown as ScenePackDefinition;
}

/**
 * Scene pack の manifest.json を shape 検証 + type narrow。
 * user scene pack でも必須（Phase 2 の design 決定、memory:
 * feedback_explicit_over_implicit_ugc）。
 */
export function validateScenePackManifest(raw: unknown, expectedId?: string): ScenePackManifest {
  if (raw === null || typeof raw !== "object") {
    throw new PackValidationError("manifest must be a JSON object");
  }
  const m = raw as Record<string, unknown>;
  if (m.type !== "scene") {
    throw new PackValidationError(`manifest type must be "scene", got "${m.type}"`);
  }
  if (typeof m.id !== "string") {
    throw new PackValidationError("manifest must have string id");
  }
  if (expectedId !== undefined && m.id !== expectedId) {
    throw new PackValidationError(
      `manifest id "${m.id}" does not match directory id "${expectedId}"`,
    );
  }
  if (typeof m.version !== "string") {
    throw new PackValidationError("manifest must have string version");
  }
  if (typeof m.yorishiroVersion !== "string") {
    throw new PackValidationError("manifest must have string yorishiroVersion");
  }
  if (typeof m.entry !== "string") {
    throw new PackValidationError("manifest must have string entry");
  }
  // Design B: defaultActive field は schema から削除済。
  // unknown field は tolerant に無視（user の古い manifest を壊さない）
  return m as unknown as ScenePackManifest;
}

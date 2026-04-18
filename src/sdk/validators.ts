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
 * Philosophy: docs/philosophy/CHARMINAL.md「壊さないこと」— SDK contract は
 * 公開された瞬間 stable。validator は user pack が古い / 新しい shape で来ても
 * 落ちる場所を明示的にするための safety net。
 */

import type { EffectDefinition, PersonaDefinition } from "./index";
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
  requireField(pack, "thinking", isObject, "an object", ctx);
  requireField(pack, "reflex", isObject, "an object", ctx);

  const reflex = pack.reflex as Record<string, unknown>;
  if (!isObject(reflex.responses)) {
    throw new PackValidationError(
      `${ctx}: field 'reflex.responses' must be an object (got ${typeof reflex.responses})`,
    );
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
  if (typeof m.charminalVersion !== "string") {
    throw new PackValidationError("manifest must have string charminalVersion");
  }
  if (typeof m.entry !== "string") {
    throw new PackValidationError("manifest must have string entry");
  }
  // Design B: defaultActive field は schema から削除済。
  // unknown field は tolerant に無視（user の古い manifest を壊さない）
  return m as unknown as ScenePackManifest;
}

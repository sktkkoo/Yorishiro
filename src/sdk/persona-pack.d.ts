/**
 * @charminal/sdk/persona-pack
 *
 * Persona Pack の manifest 型。
 * packs/personas/<id>/manifest.json が持つ field を定義する。
 *
 * Scene Pack の ScenePackManifest と対称な shape（"type": "persona"）。
 *
 * Internal design-record: 2026-04-19-persona-single-active.md
 */

/**
 * persona pack の manifest.json が持つ field。
 *
 * 例：
 * ```json
 * {
 *   "$schema": "https://charminal.dev/schemas/pack-manifest.schema.json",
 *   "id": "clai",
 *   "name": "Charminal",
 *   "type": "persona",
 *   "version": "0.1.0",
 *   "charminalVersion": "^0.1.0",
 *   "description": "...",
 *   "entry": "persona.js"
 * }
 * ```
 *
 * active 選択は pack 自己申告ではなく `~/.charminal/config.json` の
 * `primaryPersona` で user が explicit に picks する（memory:
 * feedback_single_active_config_picks、feedback_explicit_over_implicit_ugc）。
 */
export interface PersonaPackManifest {
  readonly $schema?: string;
  readonly id: string;
  readonly name?: string;
  readonly type: "persona";
  readonly version: string;
  readonly charminalVersion: string;
  readonly description?: string;
  readonly entry: string;
}

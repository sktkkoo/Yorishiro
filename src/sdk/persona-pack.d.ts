/**
 * @yorishiro/sdk/persona-pack
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
 *   "$schema": "https://yorishiro.dev/schemas/pack-manifest.schema.json",
 *   "id": "my-persona",
 *   "name": "My Persona",
 *   "type": "persona",
 *   "version": "0.1.0",
 *   "yorishiroVersion": "^0.1.0",
 *   "description": "...",
 *   "entry": "persona.js"
 * }
 * ```
 *
 * active 選択は pack 自己申告ではなく `~/.yorishiro/config.json` の
 * `primaryPersona` で user が explicit に picks する（memory:
 * feedback_single_active_config_picks、feedback_explicit_over_implicit_ugc）。
 */
export interface PersonaPackManifest {
  readonly $schema?: string;
  readonly id: string;
  readonly name?: string;
  readonly type: "persona";
  readonly version: string;
  readonly yorishiroVersion: string;
  readonly description?: string;
  readonly executionClass?: "declarative" | "isolated-js" | "trusted-main-thread-js";
  readonly artifact?: {
    readonly sha256: string;
    readonly sizeBytes: number;
  };
  readonly entry: string;
}

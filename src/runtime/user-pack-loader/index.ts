/**
 * User pack loader barrel. Phase 1-a の static load を public に露出する。
 *
 * Philosophy: docs/philosophy/CHARMINAL.md「触れるものと、触れないもの」
 * Internal design-record: 2026-04-18-user-layer-runtime.md
 */

export {
  type CharminalInitContext,
  type EffectRequester,
  type LoadInitScriptDeps,
  type LoadInitScriptResult,
  loadInitScript,
} from "./init-script";
export {
  type LoadUserLayerDeps,
  type LoadUserLayerResult,
  loadUserLayer,
} from "./runtime-wire";
export {
  type EffectRegistrar,
  type FailedPackInfo,
  type LoadedPackInfo,
  type LoadUserPacksDeps,
  type LoadUserPacksResult,
  loadUserPacks,
  type PersonaRegistrar,
  type UserPackEntry,
} from "./user-pack-loader";

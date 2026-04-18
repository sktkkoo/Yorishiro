/**
 * User pack loader barrel. Phase 1-a の static load と Phase 1-b の hot reload
 * を public に露出する。
 *
 * Philosophy: docs/philosophy/CHARMINAL.md「触れるものと、触れないもの」
 * Internal design-record: 2026-04-18-user-layer-runtime.md
 */

export {
  fetchSafeModeFlag,
  readCharminalConfigText,
  readLastStartupReport,
  writeCharminalConfigText,
  writeLastStartupReport,
} from "./charminal-io";
export {
  type CharminalConfig,
  EMPTY_CONFIG,
  parseConfig,
  serializeConfig,
  withDisabledPackAdded,
  withDisabledPackRemoved,
} from "./config";
export { filterDisabledPacks } from "./disabled-list";
export {
  type CharminalInitContext,
  type EffectRequester,
  type LoadInitScriptDeps,
  type LoadInitScriptResult,
  loadInitScript,
} from "./init-script";
export { buildLoadReport, type LoadReport, type LoadResultEntry } from "./load-report";
export {
  type LoadUserLayerDeps,
  type LoadUserLayerResult,
  loadUserLayer,
  type ReloadSingleUserPackDeps,
  reloadSingleUserPack,
} from "./runtime-wire";
export { isSafeMode } from "./safe-mode";
export {
  type EffectRegistrar,
  type FailedPackInfo,
  type LoadedPackInfo,
  type LoadSingleResult,
  type LoadSingleUserPackDeps,
  type LoadUserPacksDeps,
  type LoadUserPacksResult,
  loadSingleUserPack,
  loadUserPacks,
  type PersonaRegistrar,
  type UserPackEntry,
} from "./user-pack-loader";
export { type Disposable, UserPackRegistry } from "./user-pack-registry";
export { type PackWatcherHandle, startPackWatcher } from "./watcher";
export {
  type CharminalLayerEvent,
  mapEventToAction,
  type ParsedLayerPath,
  parseLayerPath,
  type WatcherAction,
} from "./watcher-logic";

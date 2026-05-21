/**
 * ScenePackRegistry barrel — runtime scene pack subsystem の public API。
 *
 * Internal design-record: specs/2026-04-18-scene-pack-registry.md
 */

export type { LayerResolvers, ResolveOptions } from "./asset-resolver";
export {
  isAbsoluteUrl,
  normalizeRelativePath,
  resolveBundledAsset,
  resolveLayerAssetWith,
  resolveSceneAssets,
  resolveUserAsset,
} from "./asset-resolver";
export {
  DEFAULT_BUNDLED_SCENE_ID,
  getSceneRegistry,
  ScenePackRegistryImpl,
  type ScenePackRegistryOptions,
} from "./scene-pack-registry";
export type { Disposable, PackOrigin, ScenePackEntry, ScenePackRegistry } from "./types";

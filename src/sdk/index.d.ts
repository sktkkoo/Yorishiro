/**
 * @yorishiro/sdk
 *
 * Charminal Pack を書くための型定義と API の entry point。
 *
 * 使い方：
 * ```typescript
 * import type { PersonaDefinition } from '@yorishiro/sdk';
 * import type { EffectDefinition, EffectContext } from '@yorishiro/sdk';
 * ```
 *
 * 詳しくは README.md（同じディレクトリ）を参照。
 */

export * from "./reaction";
export * from "./context";
export * from "./persona";
export * from "./effect";
export type {
  AmenityHandle,
  AmenityPackDefinition,
  AmenityPackManifest,
  AmenityToolHandler,
  AmenityToolMeta,
} from "./amenity";
export type {
  AmbientUiContext,
  AmbientUiPackDefinition,
  AmbientUiPackManifest,
} from "./ambient-ui-pack";
export type {
  AttentionAPI,
  AttentionRect,
  AttentionSnapshot,
  AttentionTarget,
  AttentionTargetKind,
} from "./attention";
export type {
  AmbientSound,
  Layer,
  LayerRole,
  ProceduralLayer,
  ProceduralLayerKind,
  SceneSpec,
  TerminalTheme,
  UiTheme,
} from "./scene";
export type {
  ScenePackCameraAPI,
  ScenePackComponentProps,
  ScenePackDefinition,
  ScenePackManifest,
} from "./scene-pack";
export type { PersonaPackManifest } from "./persona-pack";
export type { HistoryAPI, SnapshotEntry } from "./history";
export type {
  AppLanguage,
  FixedTerminalPromptKey,
  UiAppAPI,
  UiAppPackDiagnoseResponse,
  UiAppPackDiagnosis,
  UiAppPackOption,
  UiAppPackStatusEntry,
  UiHealthItem,
  UiHealthReport,
  UiClaimAPI,
  UiContext,
  UiLayout,
  UiLayoutAPI,
  UiPackDefinition,
  UiPackManifest,
  UiPresenceLevel,
  UiSceneAPI,
  UiSceneLayerPatch,
  UiSceneLayerTarget,
  UiStateAPI,
  UiThreeAPI,
  ResolvedLanguage,
} from "./ui-pack";

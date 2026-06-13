// src/core/scene/types.ts

/**
 * Scene の data model re-export。
 *
 * canonical な型定義は `src/sdk/scene.d.ts`（Phase 2 で移管）。core/scene の
 * 利用者はここから import する；pack author は `@charminal/sdk` から import する。
 *
 * Philosophy: docs/philosophy/PHILOSOPHY.md「住まうということ」
 * Internal design-record: specs/2026-04-18-scene-pack-compositor-design.md §4
 */

export type {
  Layer,
  LayerRole,
  ProceduralLayer,
  ProceduralLayerKind,
  SceneSpec,
} from "../../sdk/scene";

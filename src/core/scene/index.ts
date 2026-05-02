// src/core/scene/index.ts

/**
 * Scene Compositor barrel — public API for src/core/scene.
 *
 * Internal design-record: specs/2026-04-18-scene-pack-compositor-design.md
 */

export { SceneCompositor, type SceneCompositorProps } from "./scene-compositor";
export type { SceneRouterProps } from "./scene-router";
export { SceneRouter } from "./scene-router";
export type { Layer, LayerRole, SceneSpec } from "./types";

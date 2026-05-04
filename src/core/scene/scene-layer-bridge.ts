/**
 * Scene layer 操作の bridge.
 *
 * App.tsx が持つ scene layer override の React state を、R3F tree 内の
 * leva controls など任意の component から操作するための薄い singleton.
 * App.tsx が起動時に register し、debug controls component が利用する.
 */

import type { UiSceneLayerPatch, UiSceneLayerTarget } from "../../sdk/ui-pack";
import type { SceneSpec } from "./types";

export interface SceneLayerBridge {
  updateLayer(target: UiSceneLayerTarget, patch: UiSceneLayerPatch): void;
  resetLayer(target: UiSceneLayerTarget): void;
  getScene(): SceneSpec | null;
}

let bridge: SceneLayerBridge | null = null;

export function registerSceneLayerBridge(impl: SceneLayerBridge): void {
  bridge = impl;
}

export function getSceneLayerBridge(): SceneLayerBridge | null {
  return bridge;
}

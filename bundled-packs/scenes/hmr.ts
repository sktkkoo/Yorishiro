/**
 * Bundled scene pack の HMR re-register helper。
 *
 * dev 環境で bundled scene の terminal / ui / ambient 等の宣言変更を
 * 再起動なしで反映する。production では呼び出し元の `import.meta.hot`
 * ガードにより dead code elimination される。
 */

import type { ScenePackDefinition } from "@yorishiro/sdk/scene-pack";

export async function reregisterBundledScene(newDef: ScenePackDefinition): Promise<void> {
  const { getSceneRegistry } = await import("../../src/runtime/scene-pack-registry");
  const registry = getSceneRegistry();
  registry.register({
    id: newDef.id,
    manifest: {
      id: newDef.id,
      name: newDef.id,
      type: "scene",
      version: "0.0.0",
      charminalVersion: "^0.1.0",
      entry: "scene.ts",
    },
    scene: newDef.scene,
    origin: "bundled",
    component: newDef.component,
  });
}

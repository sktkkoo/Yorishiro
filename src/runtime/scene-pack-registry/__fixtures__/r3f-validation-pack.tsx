/**
 * R3F-component scene pack の SDK 拡張動作検証用 fixture.
 * 本ファイルは production には含めず, integration test からのみ参照する.
 *
 * Internal design-record: specs/2026-05-03-scene-pack-r3f-component.md §7 phase 4
 */

import type { ScenePackDefinition } from "../../../sdk/scene-pack";

export const r3fValidationPack: ScenePackDefinition = {
  id: "r3f-validation",
  type: "scene",
  scene: {
    id: "r3f-validation",
    layers: [],
  },
  component: () => (
    <>
      <ambientLight intensity={0.5} />
      <mesh position={[0, 1, 0]}>
        <boxGeometry args={[0.2, 0.2, 0.2]} />
        <meshBasicMaterial color="#ff00ff" wireframe />
      </mesh>
    </>
  ),
};

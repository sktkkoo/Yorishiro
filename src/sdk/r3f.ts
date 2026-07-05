/**
 * @yorishiro/sdk/r3f
 *
 * R3F primitive の re-export entry.
 *
 * Pack 作者は本 entry から R3F primitive を import することで, Yorishiro 本体と
 * 同じ @react-three/fiber version を共有する.
 *
 * user scene.tsx の runtime transpile 経路では, `@yorishiro/sdk/r3f` と
 * `@react-three/fiber` のどちらを import しても host bridge に解決される.
 * これにより pack 側に別 instance が混入することを防ぐ.
 *
 * SDK entry としては本 file を推奨 import path とし, public surface の説明を
 * ここに集約する. drei は `@react-three/drei` を host bridge 経由で共有する.
 *
 * Internal design-record: specs/2026-05-03-scene-pack-r3f-component.md §3.2
 */

export type { RootState, ThreeEvent } from "@react-three/fiber";
export {
  createPortal,
  extend,
  useFrame,
  useLoader,
  useThree,
} from "@react-three/fiber";

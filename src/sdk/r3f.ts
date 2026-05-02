/**
 * @charminal/sdk/r3f
 *
 * R3F primitive の re-export entry.
 *
 * Pack 作者は本 entry から R3F primitive を import することで, Charminal 本体と
 * 同じ @react-three/fiber version を共有する. 直接 @react-three/fiber を import
 * すると pack 側に別 instance が混入し state 不一致を起こすリスクがある.
 *
 * 本 phase では fiber の最小限のみ. drei / postprocessing は実 use case
 * （abandoned-factory 等）で必要になった時点で追加する.
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

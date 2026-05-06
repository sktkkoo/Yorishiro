/**
 * 3-light rig. 天光 (directional) + ランタン (point, flicker) + CRT (point, flicker) + 極微弱 ambient.
 *
 * useFrame で computeLanternFlicker / computeCrtFlicker を毎フレーム評価し、
 * pointLight の intensity を書き換える.
 *
 * Spec §7.1–§7.4.
 */

import { useFrame } from "@react-three/fiber";
import { useControls } from "leva";
import { useRef } from "react";
import type * as THREE from "three";
import { useControlsBridge } from "../../../../src/runtime/ui-state-store";
import { computeCrtFlicker, computeLanternFlicker, type FlickerParams } from "./flicker";
import { PALETTE } from "./palette";

/** ランタン位置. props.tsx / crt-screen.tsx からも参照される. */
export const LANTERN_POSITION: readonly [number, number, number] = [0.5, 0.2, 1.0];

/** CRT 位置. crt-screen.tsx から参照される. */
export const CRT_POSITION: readonly [number, number, number] = [-0.8, 0.6, -1.5];

export function Lights() {
  const lanternRef = useRef<THREE.PointLight>(null);
  const crtRef = useRef<THREE.PointLight>(null);

  const [controls, setControls] = useControls("lights", () => ({
    directionalIntensity: { value: 0.8, min: 0, max: 3, step: 0.05, label: "skylight int." },
    directionalColor: { value: `#${PALETTE.skylight.getHexString()}`, label: "skylight color" },
    lanternScale: { value: 0.6, min: 0, max: 3, step: 0.05, label: "lantern scale" },
    crtScale: { value: 0.85, min: 0, max: 3, step: 0.05, label: "CRT scale" },
    flickerAmount: { value: 0.15, min: 0, max: 1, step: 0.05, label: "flicker amt (0=stable)" },
    ambientIntensity: { value: 0.055, min: 0, max: 0.3, step: 0.005, label: "ambient" },
  }));
  useControlsBridge("abandoned-factory", controls, setControls);

  const flickerParams: FlickerParams = { flickerAmount: controls.flickerAmount };

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (lanternRef.current) {
      lanternRef.current.intensity =
        computeLanternFlicker(t, flickerParams) * controls.lanternScale;
    }
    if (crtRef.current) {
      crtRef.current.intensity = computeCrtFlicker(t, flickerParams) * controls.crtScale;
    }
  });

  return (
    <>
      <directionalLight
        position={[-2, 8, 1]}
        intensity={controls.directionalIntensity}
        color={controls.directionalColor}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-8}
        shadow-camera-right={8}
        shadow-camera-top={8}
        shadow-camera-bottom={-8}
        shadow-camera-near={0.1}
        shadow-camera-far={30}
      />
      <pointLight
        ref={lanternRef}
        position={[...LANTERN_POSITION]}
        color={PALETTE.lantern}
        distance={4.5}
        decay={2}
        castShadow
        shadow-mapSize={[1024, 1024]}
      />
      <pointLight
        ref={crtRef}
        position={[...CRT_POSITION]}
        color={PALETTE.crtSignal}
        distance={3.5}
        decay={2}
        castShadow={false}
      />
      <ambientLight intensity={controls.ambientIntensity} color="#0a0e14" />
    </>
  );
}

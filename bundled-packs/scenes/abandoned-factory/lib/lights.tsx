/**
 * 3-light rig. 天光 (directional) + ランタン (point, flicker) + CRT (point, flicker) + 極微弱 ambient.
 *
 * useFrame で computeLanternFlicker / computeCrtFlicker を毎フレーム評価し、
 * pointLight の intensity を書き換える.
 *
 * Spec §7.1–§7.4.
 */

import { useFrame } from "@react-three/fiber";
import { folder, useControls } from "leva";
import { useRef } from "react";
import type * as THREE from "three";
import { computeCrtFlicker, computeLanternFlicker } from "./flicker";
import { PALETTE } from "./palette";

/** ランタン位置. props.tsx / crt-screen.tsx からも参照される. */
export const LANTERN_POSITION: readonly [number, number, number] = [0.5, 0.2, 1.0];

/** CRT 位置. crt-screen.tsx から参照される. */
export const CRT_POSITION: readonly [number, number, number] = [-0.8, 0.6, -1.5];

export function Lights() {
  const lanternRef = useRef<THREE.PointLight>(null);
  const crtRef = useRef<THREE.PointLight>(null);

  const controls = useControls("abandoned-factory", {
    lights: folder({
      directionalIntensity: { value: 0.6, min: 0, max: 3, step: 0.05, label: "天光 intensity" },
      lanternScale: { value: 1.0, min: 0, max: 3, step: 0.05, label: "ランタン scale" },
      crtScale: { value: 1.0, min: 0, max: 3, step: 0.05, label: "CRT scale" },
      ambientIntensity: { value: 0.03, min: 0, max: 0.3, step: 0.005, label: "ambient" },
    }),
  });

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (lanternRef.current) {
      lanternRef.current.intensity = computeLanternFlicker(t) * controls.lanternScale;
    }
    if (crtRef.current) {
      crtRef.current.intensity = computeCrtFlicker(t) * controls.crtScale;
    }
  });

  return (
    <>
      <directionalLight
        position={[-2, 8, 1]}
        intensity={controls.directionalIntensity}
        color={PALETTE.skylight}
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

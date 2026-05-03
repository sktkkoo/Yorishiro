/**
 * 3-light rig. 天光 (directional) + ランタン (point, flicker) + CRT (point, flicker) + 極微弱 ambient.
 *
 * useFrame で computeLanternFlicker / computeCrtFlicker を毎フレーム評価し、
 * pointLight の intensity を書き換える.
 *
 * Spec §7.1–§7.4.
 */

import { useFrame } from "@react-three/fiber";
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

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (lanternRef.current) {
      lanternRef.current.intensity = computeLanternFlicker(t);
    }
    if (crtRef.current) {
      crtRef.current.intensity = computeCrtFlicker(t);
    }
  });

  return (
    <>
      {/* 天光: cool daylight が天井の隙間から差す */}
      <directionalLight
        position={[-2, 8, 1]}
        intensity={0.6}
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

      {/* ランタン: warm flicker, castShadow */}
      <pointLight
        ref={lanternRef}
        position={[...LANTERN_POSITION]}
        color={PALETTE.lantern}
        distance={4.5}
        decay={2}
        castShadow
        shadow-mapSize={[1024, 1024]}
      />

      {/* CRT モニタ: cool signal flicker, shadow なし */}
      <pointLight
        ref={crtRef}
        position={[...CRT_POSITION]}
        color={PALETTE.crtSignal}
        distance={3.5}
        decay={2}
        castShadow={false}
      />

      {/* 極微弱 ambient. 完全暗黒を避ける */}
      <ambientLight intensity={0.03} color="#0a0e14" />
    </>
  );
}

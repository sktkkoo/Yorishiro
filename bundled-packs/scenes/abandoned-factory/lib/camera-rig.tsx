/**
 * Camera modulator: breath + slow drift.
 *
 * Camera は core (ThreeRuntime) が所有しており, VRM 追従のため毎フレーム
 * camera.position.y を update + camera.lookAt(0, currentY, 0) を呼ぶ.
 * このため CameraRig が camera.position.x/y を modulate すると lookAt が
 * 角度変化として効き「シェイク」として強く感じられる.
 *
 * default では FOV breath のみ enabled で position 系は 0. user が leva で
 * dial up したい場合は positionAmpX/Y や driftAmpX/Y を上げる.
 *
 * leva controls (folder "abandoned-factory > camera"):
 *   - fovBreathAmp: FOV breath の振幅（degrees, default 0.15）
 *   - positionAmpX/Y: position breath の振幅（meters, default 0）
 *   - driftAmpX/Y: Perlin drift の振幅（meters, default 0）
 */

import { useFrame } from "@react-three/fiber";
import { folder, useControls } from "leva";
import { useRef } from "react";
import * as THREE from "three";
import { perlin1d } from "./perlin";

interface BreathOffset {
  x: number;
  y: number;
  fov: number;
}

export function CameraRig(): null {
  const baseFovRef = useRef<number | null>(null);
  const lastBreathRef = useRef<BreathOffset>({ x: 0, y: 0, fov: 0 });
  const lastDriftRef = useRef(new THREE.Vector3());

  const { fovBreathAmp, positionAmpX, positionAmpY, driftAmpX, driftAmpY } = useControls(
    "abandoned-factory",
    {
      camera: folder(
        {
          fovBreathAmp: { value: 0.15, min: 0, max: 1.0, step: 0.01 },
          positionAmpX: { value: 0, min: 0, max: 0.05, step: 0.001 },
          positionAmpY: { value: 0, min: 0, max: 0.05, step: 0.001 },
          driftAmpX: { value: 0, min: 0, max: 0.1, step: 0.001 },
          driftAmpY: { value: 0, min: 0, max: 0.1, step: 0.001 },
        },
        { collapsed: true },
      ),
    },
  );

  useFrame(({ camera, clock }) => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return;

    if (baseFovRef.current === null) {
      baseFovRef.current = camera.fov;
    }
    const baseFov = baseFovRef.current;

    const lastBreath = lastBreathRef.current;
    const lastDrift = lastDriftRef.current;

    /* --- 前フレームの offset を戻す --- */
    camera.position.x -= lastBreath.x + lastDrift.x;
    camera.position.y -= lastBreath.y + lastDrift.y;
    camera.fov = baseFov;

    /* --- 新しい offset を計算 --- */
    const t = clock.getElapsedTime();

    const breathX = Math.sin(t * 1.4) * positionAmpX;
    const breathY = Math.sin(t * 1.1) * positionAmpY;
    const breathFov = Math.sin(t * 1.4) * fovBreathAmp;

    const driftX = perlin1d(t * 0.04) * driftAmpX;
    const driftY = perlin1d(t * 0.04 + 100) * driftAmpY;

    /* --- 新しい offset を適用 --- */
    camera.position.x += breathX + driftX;
    camera.position.y += breathY + driftY;
    camera.fov = baseFov + breathFov;
    camera.updateProjectionMatrix();

    lastBreathRef.current = { x: breathX, y: breathY, fov: breathFov };
    lastDrift.set(driftX, driftY, 0);
  });

  return null;
}

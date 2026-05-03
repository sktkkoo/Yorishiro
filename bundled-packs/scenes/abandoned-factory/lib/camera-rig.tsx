/**
 * Camera modulator: breath + slow drift.
 *
 * Camera は core が所有しているため pack は per-frame offset を加えるだけ.
 * 前フレームで加えた offset を一度引いてから新 offset を加える.
 */

import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { perlin1d } from "./perlin";

/** 前フレームの breath offset */
interface BreathOffset {
  x: number;
  y: number;
  fov: number;
}

export function CameraRig(): null {
  const baseFovRef = useRef<number | null>(null);
  const lastBreathRef = useRef<BreathOffset>({ x: 0, y: 0, fov: 0 });
  const lastDriftRef = useRef(new THREE.Vector3());

  useFrame(({ camera, clock }) => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return;

    /* 初回フレームで base FOV を記録 */
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

    // breath: 呼吸のような微細な揺れ（周期 4-5 秒）
    const breathX = Math.sin(t * 1.4) * 0.005;
    const breathY = Math.sin(t * 1.1) * 0.003;
    const breathFov = Math.sin(t * 1.4) * 0.3;

    // drift: Perlin noise による緩やかな漂流（30+ 秒周期）
    const driftX = perlin1d(t * 0.04) * 0.02;
    const driftY = perlin1d(t * 0.04 + 100) * 0.015;

    /* --- 新しい offset を適用 --- */
    camera.position.x += breathX + driftX;
    camera.position.y += breathY + driftY;
    camera.fov = baseFov + breathFov;
    camera.updateProjectionMatrix();

    /* --- 次フレーム用に保存 --- */
    lastBreathRef.current = { x: breathX, y: breathY, fov: breathFov };
    lastDrift.set(driftX, driftY, 0);
  });

  return null;
}

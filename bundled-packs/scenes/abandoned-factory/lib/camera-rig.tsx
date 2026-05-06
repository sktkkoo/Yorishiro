/**
 * Camera modulator: FOV breath のみ.
 *
 * camera.position / camera.rotation は ThreeRuntime が VRM 追従で毎フレーム
 * 上書き + lookAt するため, pack 側から触ると oscillation する.
 * camera.fov は ThreeRuntime が触らないので pack が安全に modulate できる.
 *
 * leva で振幅を runtime 調整可能.
 */

import { useFrame } from "@react-three/fiber";
import { folder, useControls } from "leva";
import { useRef } from "react";
import * as THREE from "three";
import { useControlsBridge } from "../../../../src/runtime/ui-state-store";

export function CameraRig(): null {
  const baseFovRef = useRef<number | null>(null);

  const [controls, setControls] = useControls("camera", () => ({
    camera: folder(
      {
        fovBreathAmp: { value: 0.15, min: 0, max: 1.0, step: 0.01, label: "FOV breath (°)" },
      },
      { collapsed: true },
    ),
  }));
  useControlsBridge("abandoned-factory", controls, setControls);
  const { fovBreathAmp } = controls;

  useFrame(({ camera, clock }) => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return;

    if (baseFovRef.current === null) {
      baseFovRef.current = camera.fov;
    }

    const t = clock.getElapsedTime();
    camera.fov = baseFovRef.current + Math.sin(t * 1.4) * fovBreathAmp;
    camera.updateProjectionMatrix();
  });

  return null;
}

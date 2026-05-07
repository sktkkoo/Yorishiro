/**
 * Camera debug controls (leva).
 *
 * R3fRuntimeRoot 内で常時 mount される。tracking / position / target / FOV / lookAt を
 * leva 経由で操作する。tracking OFF 時は ThreeRuntime の render loop が
 * camera.position を上書きしないため、leva の値がそのまま反映される。
 */

import { useFrame } from "@react-three/fiber";
import { folder, useControls } from "leva";
import { useRef } from "react";
import { getThreeRuntime } from "../../runtime/three-runtime";
import type { RuntimeLevaStore } from "../../runtime/three-runtime/runtime-leva-store";

export interface CameraControlsProps {
  readonly store?: RuntimeLevaStore;
}

export function CameraControls({ store }: CameraControlsProps) {
  const runtime = getThreeRuntime();
  const camera = runtime.getCamera();
  const prevTracking = useRef(runtime.getCameraTracking());

  const [controls, set] = useControls(
    () => ({
      camera: folder({
        tracking: { value: runtime.getCameraTracking(), label: "tracking" },
        lookAtCharacter: { value: true, label: "look at character" },
        x: { value: camera.position.x, min: -5, max: 5, step: 0.01, label: "x" },
        y: { value: camera.position.y, min: -2, max: 5, step: 0.01, label: "y" },
        z: { value: camera.position.z, min: 0.1, max: 10, step: 0.01, label: "z" },
        targetX: { value: 0, min: -5, max: 5, step: 0.01, label: "target x" },
        targetY: { value: camera.position.y, min: -2, max: 5, step: 0.01, label: "target y" },
        targetZ: { value: 0, min: -5, max: 5, step: 0.01, label: "target z" },
        fov: { value: camera.fov, min: 20, max: 120, step: 1, label: "FOV" },
      }),
    }),
    { store },
    [],
  );

  useFrame(() => {
    if (controls.tracking !== prevTracking.current) {
      prevTracking.current = controls.tracking;
      runtime.setCameraTracking(controls.tracking);
    }

    if (!controls.tracking) {
      camera.position.set(controls.x, controls.y, controls.z);
      if (controls.lookAtCharacter) {
        camera.lookAt(0, controls.y, 0);
      } else {
        camera.lookAt(controls.targetX, controls.targetY, controls.targetZ);
      }
    }

    if (camera.fov !== controls.fov) {
      camera.fov = controls.fov;
      camera.updateProjectionMatrix();
    }
  });

  useFrame(() => {
    if (controls.tracking) {
      const changed =
        Math.abs(camera.position.x - controls.x) > 0.005 ||
        Math.abs(camera.position.y - controls.y) > 0.005 ||
        Math.abs(camera.position.z - controls.z) > 0.005;
      if (changed) {
        set({
          x: camera.position.x,
          y: camera.position.y,
          z: camera.position.z,
        });
      }
    }
  });

  return null;
}

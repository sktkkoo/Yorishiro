/**
 * Camera debug controls (leva).
 *
 * R3fRuntimeRoot 内で常時 mount される。leva 経由で以下を操作する:
 *
 * ┌─ tracking (toggle)
 * ├─ look at character (toggle)
 * ├─ offset/ ─ x, y, z      ← tracking ON 時のカメラ位置オフセット
 * ├─ x, y, z                 ← tracking OFF 時の直接位置指定
 * ├─ yaw (deg), pitch (deg)  ← lookAt OFF 時の直接回転指定
 * └─ FOV
 *
 * tracking ON  → ThreeRuntime の render loop がカメラ位置を設定、offset が加算される
 * tracking OFF → x/y/z でカメラ位置を直接制御
 * lookAt ON    → 毎フレーム character 位置に lookAt
 * lookAt OFF   → lookAt を呼ばず yaw/pitch (Euler YXZ) で直接回転制御
 */

import { useFrame } from "@react-three/fiber";
import { folder, useControls } from "leva";
import { useRef } from "react";
import { getThreeRuntime } from "../../runtime/three-runtime";
import type { RuntimeLevaStore } from "../../runtime/three-runtime/runtime-leva-store";

const DEG2RAD = Math.PI / 180;

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
        tracking: { value: false, label: "tracking" },
        offsetX: {
          value: 0,
          min: -3,
          max: 3,
          step: 0.01,
          label: "offset x",
          render: (get) => get("camera.tracking"),
        },
        offsetY: {
          value: 0,
          min: -2,
          max: 2,
          step: 0.01,
          label: "offset y",
          render: (get) => get("camera.tracking"),
        },
        offsetZ: {
          value: 0,
          min: -3,
          max: 3,
          step: 0.01,
          label: "offset z",
          render: (get) => get("camera.tracking"),
        },
        lookAtCharacter: { value: true, label: "look at character" },
        x: { value: camera.position.x, min: -5, max: 5, step: 0.01, label: "x" },
        y: { value: camera.position.y, min: -2, max: 5, step: 0.01, label: "y" },
        z: { value: camera.position.z, min: 0.1, max: 10, step: 0.01, label: "z" },
        rotationY: { value: 0, min: -180, max: 180, step: 0.5, label: "yaw (deg)" },
        rotationX: { value: 0, min: -90, max: 90, step: 0.5, label: "pitch (deg)" },
        fov: { value: camera.fov, min: 20, max: 120, step: 1, label: "FOV" },
      }),
    }),
    { store },
    [],
  );

  // tracking ON 時: ThreeRuntime が設定した base position に offset を加算する。
  useFrame(() => {
    if (controls.tracking !== prevTracking.current) {
      prevTracking.current = controls.tracking;
      runtime.setCameraTracking(controls.tracking);
    }

    // camera-move / UI pack などが camera を claim している間は、leva の手動制御を
    // 譲る。claim 中に position/fov を毎フレーム書くと、claim 側（例: 銃撃の
    // camera-move）の applyState を打ち消し、tracking OFF だとカメラが動かなくなる。
    // render loop (three-runtime tick) の Step1-3 も同じ claim を見て camera 制御を skip する。
    if (runtime.isCameraClaimed()) return;

    if (controls.tracking) {
      camera.position.x += controls.offsetX;
      camera.position.y += controls.offsetY;
      camera.position.z += controls.offsetZ;
    }

    if (!controls.tracking) {
      camera.position.set(controls.x, controls.y, controls.z);
      if (controls.lookAtCharacter) {
        camera.lookAt(0, controls.y, 0);
      } else {
        camera.rotation.order = "YXZ";
        camera.rotation.set(controls.rotationX * DEG2RAD, controls.rotationY * DEG2RAD, 0);
      }
    }

    if (camera.fov !== controls.fov) {
      camera.fov = controls.fov;
      camera.updateProjectionMatrix();
    }
  });

  // tracking ON 時: base position (offset 込み) を leva の x/y/z に逆流させる。
  // claim 中は claim 側が camera を制御しているので、その位置を逆流させない。
  useFrame(() => {
    if (controls.tracking && !runtime.isCameraClaimed()) {
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

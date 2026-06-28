/**
 * simple-room の lighting rig.
 *
 * 夜の静かな部屋を一灯で作る。directional+ambient のフラットな照明ではなく、
 * 暖色のスポットライト 1 灯を VRM に当て、毎フレーム target を追従させる。
 * 値は simple-room (Night) に合わせた。SDK controls で intensity / color / 位置等を調整可能。
 */

import { useCharminalControls } from "@charminal/sdk/controls";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import type { SpotLight as ThreeSpotLight } from "three";
import { useControlsBridge } from "../../../../src/runtime/ui-state-store";

export function Lights() {
  const lightRef = useRef<ThreeSpotLight>(null);
  const [controls, setControls] = useCharminalControls("lights", () => ({
    intensity: { value: 1.5, min: 0, max: 3, step: 0.01, label: "intensity" },
    color: { value: "#ffe8ea", label: "color" },
    x: { value: -0.2, min: -5, max: 5, step: 0.1, label: "X" },
    y: { value: 1.9, min: -5, max: 5, step: 0.1, label: "Y" },
    z: { value: 0.4, min: -5, max: 5, step: 0.1, label: "Z" },
    targetX: { value: 0.1, min: -3, max: 3, step: 0.1, label: "target X" },
    targetY: { value: -0.1, min: -1, max: 3, step: 0.1, label: "target Y" },
    targetZ: { value: 0, min: -3, max: 3, step: 0.1, label: "target Z" },
    angle: { value: 0.85, min: 0.05, max: 1.5, step: 0.01, label: "angle" },
    penumbra: { value: 0.74, min: 0, max: 1, step: 0.01, label: "penumbra" },
    distance: { value: 1.4, min: 0, max: 20, step: 0.1, label: "distance" },
    decay: { value: 1.1, min: 0, max: 5, step: 0.1, label: "decay" },
  }));
  useControlsBridge("simple-room", controls, setControls);

  useFrame(() => {
    if (lightRef.current) {
      lightRef.current.target.position.set(controls.targetX, controls.targetY, controls.targetZ);
      lightRef.current.target.updateMatrixWorld();
    }
  });

  return (
    <spotLight
      ref={lightRef}
      position={[controls.x, controls.y, controls.z]}
      intensity={controls.intensity}
      color={controls.color}
      angle={controls.angle}
      penumbra={controls.penumbra}
      distance={controls.distance}
      decay={controls.decay}
    />
  );
}

/**
 * misty-grasslands の lighting rig.
 *
 * overcast morning の拡散光: 弱い directional + hemisphere ambient.
 * SDK controls で intensity / color を調整可能.
 */

import { useSceneMainLight, useYorishiroControls } from "@yorishiro/sdk/controls";
import { useRef } from "react";
import type { DirectionalLight } from "three";
import { useControlsBridge } from "../../../../src/runtime/ui-state-store";

export function Lights() {
  const directionalRef = useRef<DirectionalLight>(null);
  const [controls, setControls] = useYorishiroControls("lights", () => ({
    directionalIntensity: { value: 1.5, min: 0, max: 3, step: 0.05, label: "sun int." },
    directionalColor: { value: "#ebe9e1", label: "sun color" },
    ambientIntensity: { value: 0.47, min: 0, max: 1, step: 0.02, label: "ambient int." },
    ambientColor: { value: "#bfdebe", label: "ambient color" },
  }));
  useControlsBridge("misty-grasslands", controls, setControls);
  useSceneMainLight(directionalRef, {
    intensity: controls.directionalIntensity,
    color: controls.directionalColor,
  });

  return (
    <>
      <directionalLight
        ref={directionalRef}
        position={[-3, 6, 2]}
        intensity={controls.directionalIntensity}
        color={controls.directionalColor}
      />
      <ambientLight intensity={controls.ambientIntensity} color={controls.ambientColor} />
    </>
  );
}

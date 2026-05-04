/**
 * misty-grasslands の lighting rig.
 *
 * overcast morning の拡散光: 弱い directional + hemisphere ambient.
 * leva で intensity / color を調整可能.
 */

import { folder, useControls } from "leva";
import { useControlsBridge } from "../../../../src/runtime/ui-state-store";

export function Lights() {
  const [controls, setControls] = useControls("misty-grasslands", () => ({
    lights: folder({
      directionalIntensity: { value: 0.6, min: 0, max: 3, step: 0.05, label: "sun int." },
      directionalColor: { value: "#c8cdd4", label: "sun color" },
      ambientIntensity: { value: 0.35, min: 0, max: 1, step: 0.02, label: "ambient int." },
      ambientColor: { value: "#d6d9d2", label: "ambient color" },
    }),
  }));
  useControlsBridge("misty-grasslands", controls, setControls);

  return (
    <>
      <directionalLight
        position={[-3, 6, 2]}
        intensity={controls.directionalIntensity}
        color={controls.directionalColor}
      />
      <ambientLight intensity={controls.ambientIntensity} color={controls.ambientColor} />
    </>
  );
}

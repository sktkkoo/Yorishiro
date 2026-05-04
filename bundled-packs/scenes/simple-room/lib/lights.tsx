/**
 * simple-room の lighting rig.
 *
 * 静かな部屋の控えめな lighting. leva で intensity / color を調整可能.
 */

import { useControls } from "leva";
import { useControlsBridge } from "../../../../src/runtime/ui-state-store";

export function Lights() {
  const [controls, setControls] = useControls("lights", () => ({
    directionalIntensity: { value: 0.8, min: 0, max: 3, step: 0.05, label: "light int." },
    directionalColor: { value: "#ffffff", label: "light color" },
    ambientIntensity: { value: 0.4, min: 0, max: 1, step: 0.02, label: "ambient int." },
    ambientColor: { value: "#ffffff", label: "ambient color" },
  }));
  useControlsBridge("lights", controls, setControls);

  return (
    <>
      <directionalLight
        position={[1, 2, 2]}
        intensity={controls.directionalIntensity}
        color={controls.directionalColor}
      />
      <ambientLight intensity={controls.ambientIntensity} color={controls.ambientColor} />
    </>
  );
}

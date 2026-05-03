/**
 * abandoned-factory scene pack.
 *
 * 鳩羽つぐ × Tarkovsky『ストーカー』(image only) × Serial Experiments Lain
 * (post-process) の三軸の廃工場 scene。VRM と同一 Three.js scene に environment /
 * lights / props / post-process を mount する R3F-component pack。
 *
 * Internal design-record:
 * - specs/2026-05-03-abandoned-factory-scene-design.md
 * - specs/2026-05-03-scene-pack-r3f-component.md
 */

import type { ScenePackComponentProps, ScenePackDefinition } from "@charminal/sdk/scene-pack";
import { folder, useControls } from "leva";
import { useControlsBridge } from "../../../src/runtime/ui-state-store";
import { DustMotes } from "./lib/atmosphere";
import { CameraBreath } from "./lib/camera-breath";
import { Ceiling } from "./lib/ceiling";
import { CrtScreen } from "./lib/crt-screen";
import { DistantPipes } from "./lib/distant-pipes";
import { Floor } from "./lib/floor";
import { Lights } from "./lib/lights";
import { AbandonedFactoryPostProcess } from "./lib/post-process";
import { PowerLine } from "./lib/power-line";
import { AbandonedFactoryProps } from "./lib/props";
import { Walls } from "./lib/walls";

function AbandonedFactoryScene({ vrmSlot, resolveAsset, camera }: ScenePackComponentProps) {
  const [breathControls, setBreath] = useControls("abandoned-factory", () => ({
    cameraBreath: folder(
      {
        freqX: { value: 1.4, min: 0.1, max: 5, step: 0.1 },
        freqY: { value: 0.9, min: 0.1, max: 5, step: 0.1 },
        freqZ: { value: 0.6, min: 0.1, max: 5, step: 0.1 },
        ampX: { value: 0.002, min: 0, max: 0.02, step: 0.001 },
        ampY: { value: 0.003, min: 0, max: 0.02, step: 0.001 },
        ampZ: { value: 0.001, min: 0, max: 0.02, step: 0.001 },
        fovAmp: { value: 0.15, min: 0, max: 1, step: 0.01 },
      },
      { collapsed: true },
    ),
  }));
  useControlsBridge("abandoned-factory", breathControls, setBreath);

  return (
    <>
      <Lights />
      <Floor />
      <Walls />
      <Ceiling />
      <DustMotes />
      <PowerLine />
      <DistantPipes />
      <AbandonedFactoryProps resolveAsset={resolveAsset} />
      <CrtScreen />
      <CameraBreath
        camera={camera}
        freqX={breathControls.freqX}
        freqY={breathControls.freqY}
        freqZ={breathControls.freqZ}
        ampX={breathControls.ampX}
        ampY={breathControls.ampY}
        ampZ={breathControls.ampZ}
        fovAmp={breathControls.fovAmp}
      />
      {vrmSlot}
      <AbandonedFactoryPostProcess />
    </>
  );
}

const definition: ScenePackDefinition = {
  id: "abandoned-factory",
  type: "scene",
  scene: {
    id: "abandoned-factory",
    layers: [],
    ambient: [
      { src: "sound:abandoned-factory/distant-machine-hum", volume: 0.1 },
      { src: "sound:abandoned-factory/crt-static", volume: 0.06 },
    ],
    terminal: {
      background: "#0a0e14",
      foreground: "#a0a8b4",
      cursor: "#7a8c9c",
    },
    ui: {
      background: "#0a0e14",
      foreground: "#a0a8b4",
      foregroundDim: "rgba(160, 168, 180, 0.5)",
    },
  },
  component: AbandonedFactoryScene,
};

export default definition;

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
import { DustMotes, GodRays } from "./lib/atmosphere";
import { Ceiling } from "./lib/ceiling";
import { CrtScreen } from "./lib/crt-screen";
import { DistantPipes } from "./lib/distant-pipes";
import { Floor } from "./lib/floor";
import { Lights } from "./lib/lights";
import { AbandonedFactoryPostProcess } from "./lib/post-process";
import { PowerLine } from "./lib/power-line";
import { AbandonedFactoryProps } from "./lib/props";
import { Walls } from "./lib/walls";

function AbandonedFactoryScene({ vrmSlot, resolveAsset }: ScenePackComponentProps) {
  return (
    <>
      <Lights />
      <Floor />
      <Walls />
      <Ceiling />
      <DustMotes />
      <GodRays />
      <PowerLine />
      <DistantPipes />
      <AbandonedFactoryProps resolveAsset={resolveAsset} />
      <CrtScreen />
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

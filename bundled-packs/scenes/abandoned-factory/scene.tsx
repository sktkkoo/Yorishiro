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

import { controlFolder, useCharminalControls } from "@charminal/sdk/controls";
import type { ScenePackComponentProps, ScenePackDefinition } from "@charminal/sdk/scene-pack";
import { AttentionCueLight } from "../../../src/runtime/three-runtime/attention-cue-light";
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
  const [breathControls, setBreath] = useCharminalControls("camera", () => ({
    breath: controlFolder(
      {
        freqX: { value: 1.7, min: 0.1, max: 5, step: 0.1 },
        freqY: { value: 0.7, min: 0.1, max: 5, step: 0.1 },
        freqZ: { value: 0.6, min: 0.1, max: 5, step: 0.1 },
        ampX: { value: 0.001, min: 0, max: 0.02, step: 0.001 },
        ampY: { value: 0.001, min: 0, max: 0.02, step: 0.001 },
        ampZ: { value: 0, min: 0, max: 0.02, step: 0.001 },
        fovAmp: { value: 0, min: 0, max: 1, step: 0.01 },
      },
      { collapsed: true },
    ),
  }));
  useControlsBridge("abandoned-factory", breathControls, setBreath);

  return (
    <>
      <Lights />
      <AttentionCueLight />
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
    ambient: [{ src: "./assets/abandoned-factory_piano-loop.mp3", volume: 0.15 }],
    terminal: {
      background: "#1a1a19",
      foreground: "#a0a09a",
      cursor: "#8a8a80",
      cursorAccent: "#1a1a19",
      selectionBackground: "#2e2e2a",
      selectionForeground: "#c8c8c0",
      black: "#121211",
      red: "#c45c5c",
      green: "#6a9a7b",
      yellow: "#b89a6a",
      blue: "#7a8a8a",
      magenta: "#8a6a7a",
      cyan: "#6a8a80",
      white: "#a0a09a",
      brightBlack: "#3a3a36",
      brightRed: "#d47a7a",
      brightGreen: "#7aaa8b",
      brightYellow: "#ccad7a",
      brightBlue: "#8a9a98",
      brightMagenta: "#a07a90",
      brightCyan: "#7aaa9a",
      brightWhite: "#c8c8c0",
    },
    ui: {
      background: "#181818",
      foreground: "#9a9a94",
      foregroundDim: "rgba(154, 154, 148, 0.45)",
      sidebarBackground: "#141413",
      panelBackground: "rgba(24, 24, 23, 0.96)",
      border: "rgba(80, 80, 74, 0.35)",
      buttonBackground: "#2a2a28",
      buttonForeground: "#8a8a84",
      inputBackground: "rgba(255, 255, 255, 0.03)",
      accent: "rgba(140, 140, 130, 1)",
      accentSoft: "rgba(140, 140, 130, 0.08)",
      accentBorder: "rgba(140, 140, 130, 0.25)",
      muted: "#4a4a46",
      glow: "rgba(140, 140, 130, 0.05)",
    },
  },
  component: AbandonedFactoryScene,
};

export default definition;

if (import.meta.hot) {
  import.meta.hot.accept(async (newModule) => {
    if (!newModule?.default) return;
    const { reregisterBundledScene } = await import("../hmr");
    await reregisterBundledScene(newModule.default);
  });
}

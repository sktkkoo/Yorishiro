/**
 * Bundled scene pack「光の草原」.
 *
 * 草原は procedural layer として VRM とは別の rendering context で描画。
 * VRM のカメラ位置と草原のカメラ位置が独立するため、草の密生具合を
 * 草原側カメラの奥行きで表現できる。
 *
 * component は VRM に当たる lighting のみを leva 経由で提供する。
 * R3fRuntimeRoot が component を検出し default lights を disable →
 * 代わりに Lights コンポーネントが VRM を照らす。
 *
 * Internal design-record: 2026-04-29-misty-grasslands-mirror-redesign.md
 */

import type { ScenePackComponentProps, ScenePackDefinition } from "@charminal/sdk/scene-pack";
import { Lights } from "./lib/lights";

function MistyGrasslandsLighting(_props: ScenePackComponentProps) {
  return <Lights />;
}

const definition: ScenePackDefinition = {
  id: "misty-grasslands",
  type: "scene",
  scene: {
    id: "misty-grasslands",
    layers: [
      {
        id: "misty-grasslands-three",
        role: "background",
        procedural: { kind: "misty-grasslands" },
        blur: 1,
      },
      {
        id: "vrm-slot",
        role: "character",
        blur: 0,
      },
      {
        id: "warm-foreground-haze",
        role: "foreground",
        backgroundImage:
          "radial-gradient(ellipse at 50% 44%, transparent 48%, rgba(255, 236, 180, 0.1) 72%, rgba(43, 73, 48, 0.28) 100%)",
      },
    ],
    ambient: [{ src: "sound:calming-rain", volume: 0.08 }],
    terminal: {
      background: "#d6dcc8",
      foreground: "#5c6a72",
      cursor: "#8da101",
      cursorAccent: "#d6dcc8",
      selectionBackground: "#b8c4a8",
      selectionForeground: "#5c6a72",
      black: "#d6dcc8",
      red: "#f85552",
      green: "#8da101",
      yellow: "#9a7a00",
      blue: "#3a94c5",
      magenta: "#df69ba",
      cyan: "#35a77c",
      white: "#d6dcc8",
      brightBlack: "#829181",
      brightRed: "#f85552",
      brightGreen: "#8da101",
      brightYellow: "#dfa000",
      brightBlue: "#3a94c5",
      brightMagenta: "#df69ba",
      brightCyan: "#35a77c",
      brightWhite: "#e8ece0",
    },
    ui: {
      background: "#d6dcc8",
      foreground: "#1e2a1a",
      foregroundDim: "rgba(30, 42, 26, 0.5)",
      sidebarBackground: "#cad2bc",
      panelBackground: "rgba(202, 210, 188, 0.96)",
      border: "rgba(60, 72, 50, 0.25)",
      buttonBackground: "#bec8ae",
      buttonForeground: "#3a4a30",
      inputBackground: "rgba(0, 0, 0, 0.04)",
      accent: "rgba(74, 122, 52, 1)",
      accentSoft: "rgba(74, 122, 52, 0.1)",
      accentBorder: "rgba(74, 122, 52, 0.25)",
      muted: "#7a8a70",
      glow: "rgba(74, 122, 52, 0.08)",
    },
  },
  component: MistyGrasslandsLighting,
};

export default definition;

if (import.meta.hot) {
  import.meta.hot.accept(async (newModule) => {
    if (!newModule?.default) return;
    const { reregisterBundledScene } = await import("../hmr");
    await reregisterBundledScene(newModule.default);
  });
}

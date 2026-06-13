/**
 * Bundled reference scene pack「静かな部屋」.
 *
 * Charminal の reference scene：整った polish を控えめな方向で示す手本.
 * 背景・vignette は DOM layer (CSS gradient) で描画し、lighting のみ R3F component
 * が担当する hybrid 構成。DOM layer が SceneCompositor を通るため debug controls
 * の "load bg" / "load fg" でメディア差し替えが効く。
 *
 * Philosophy: docs/philosophy/PHILOSOPHY.md「UI は環境である」
 * Internal design-record: specs/2026-04-18-scene-pack-compositor-design.md §2.3
 */

import type { ScenePackComponentProps, ScenePackDefinition } from "@charminal/sdk/scene-pack";
import { Lights } from "./lib/lights";

function SimpleRoomScene({ vrmSlot }: ScenePackComponentProps) {
  return (
    <>
      <Lights />
      {vrmSlot}
    </>
  );
}

const definition: ScenePackDefinition = {
  id: "simple-room",
  type: "scene",
  scene: {
    id: "simple-room",
    layers: [
      {
        id: "backdrop",
        role: "background",
        backgroundImage:
          "radial-gradient(ellipse at 50% 30%, rgba(120, 150, 200, 0.18) 0%, transparent 70%), linear-gradient(180deg, #232838 0%, #161a24 100%)",
      },
      {
        id: "vrm-slot",
        role: "character",
        blur: 0,
      },
      {
        id: "fg-vignette",
        role: "foreground",
        backgroundImage:
          "radial-gradient(ellipse at 50% 60%, transparent 60%, rgba(0, 0, 0, 0.35) 100%)",
      },
    ],
    ambient: [],
    terminal: {
      background: "#0f1923",
      foreground: "#eceff4",
      cursor: "#4dd9cf",
      cursorAccent: "#0f1923",
      selectionBackground: "#243447",
      selectionForeground: "#eceff4",
      black: "#0f1923",
      red: "#ff6b8a",
      green: "#4dd9cf",
      yellow: "#f0c674",
      blue: "#81a2be",
      magenta: "#b294bb",
      cyan: "#39c5bb",
      white: "#eceff4",
      brightBlack: "#3b5068",
      brightRed: "#ff8da5",
      brightGreen: "#6eded6",
      brightYellow: "#f5d6a0",
      brightBlue: "#a8c8e0",
      brightMagenta: "#c9aed0",
      brightCyan: "#7eeee6",
      brightWhite: "#ffffff",
    },
    ui: {
      background: "#0f1923",
      foreground: "#eceff4",
      foregroundDim: "rgba(236, 239, 244, 0.55)",
      sidebarBackground: "#0a1118",
      panelBackground: "rgba(14, 23, 34, 0.96)",
      border: "rgba(59, 80, 104, 0.5)",
      buttonBackground: "#243447",
      buttonForeground: "#a8b8cc",
      inputBackground: "rgba(255, 255, 255, 0.04)",
      accent: "rgba(77, 217, 207, 1)",
      accentSoft: "rgba(77, 217, 207, 0.08)",
      accentBorder: "rgba(77, 217, 207, 0.25)",
      muted: "#3b5068",
      glow: "rgba(77, 217, 207, 0.06)",
    },
  },
  component: SimpleRoomScene,
};

export default definition;

if (import.meta.hot) {
  import.meta.hot.accept(async (newModule) => {
    if (!newModule?.default) return;
    const { reregisterBundledScene } = await import("../hmr");
    await reregisterBundledScene(newModule.default);
  });
}

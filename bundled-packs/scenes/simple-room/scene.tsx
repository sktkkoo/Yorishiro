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
        // 中立 charcoal（青みは気配程度に脱飽和）＋ 色の付かない柔らかい光だまり。
        backgroundImage:
          "radial-gradient(ellipse at 50% 30%, rgba(198, 204, 212, 0.10) 0%, transparent 70%), linear-gradient(180deg, #26282c 0%, #16181b 100%)",
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
      background: "#141619",
      foreground: "#e8ebe7",
      cursor: "#8eb09c",
      cursorAccent: "#141619",
      selectionBackground: "#28302b",
      selectionForeground: "#e8ebe7",
      black: "#141619",
      red: "#d28a8a",
      green: "#9cbd8a",
      yellow: "#d8b777",
      blue: "#8aa0bd",
      magenta: "#a896b8",
      cyan: "#7bb0ab",
      white: "#d8dbd6",
      brightBlack: "#56615b",
      brightRed: "#e0a0a0",
      brightGreen: "#b3d1a3",
      brightYellow: "#e6cb95",
      brightBlue: "#a6bcd6",
      brightMagenta: "#c0b0cf",
      brightCyan: "#9accc6",
      brightWhite: "#f3f4f1",
    },
    ui: {
      background: "#141619",
      foreground: "#e8ebe7",
      foregroundDim: "rgba(232, 235, 231, 0.55)",
      sidebarBackground: "#0e0f11",
      panelBackground: "rgba(20, 22, 25, 0.96)",
      border: "rgba(120, 134, 124, 0.28)",
      buttonBackground: "#24282b",
      buttonForeground: "#aab4ac",
      inputBackground: "rgba(255, 255, 255, 0.04)",
      accent: "rgba(142, 176, 156, 1)",
      accentSoft: "rgba(142, 176, 156, 0.08)",
      accentBorder: "rgba(142, 176, 156, 0.25)",
      muted: "#56615b",
      glow: "rgba(142, 176, 156, 0.06)",
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

/**
 * Bundled scene pack「光の草原」。
 *
 * Scene pack は宣言型のまま、runtime 内蔵の Three.js procedural renderer
 * `radiant-meadow` を background として指定する。住人を前景化しすぎず、
 * 画面全体に静かな奥行きと風を作るための scene。
 */

import type { ScenePackDefinition } from "@charminal/sdk";

export default {
  id: "radiant-meadow",
  type: "scene",
  scene: {
    id: "radiant-meadow",
    layers: [
      {
        id: "radiant-meadow-three",
        role: "background",
        procedural: { kind: "radiant-meadow" },
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
} satisfies ScenePackDefinition;

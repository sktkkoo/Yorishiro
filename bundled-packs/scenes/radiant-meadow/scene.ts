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
  },
} satisfies ScenePackDefinition;

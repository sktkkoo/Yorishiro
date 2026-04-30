import { describe, it } from "vitest";
import type { AmbientSound, ProceduralLayer, SceneSpec } from "./scene";

describe("SceneSpec.ambient (type)", () => {
  it("accepts an ambient field with src + volume", () => {
    const _scene: SceneSpec = {
      id: "test",
      layers: [],
      ambient: [{ src: "sound:rain", volume: 0.5 }, { src: "./assets/cafe.mp3" }],
    };
    void _scene;
  });

  it("accepts AmbientSound with only src (volume optional)", () => {
    const _s: AmbientSound = { src: "sound:wind" };
    void _s;
  });

  it("accepts a procedural misty-grasslands layer", () => {
    const _procedural: ProceduralLayer = { kind: "misty-grasslands" };
    const _scene: SceneSpec = {
      id: "procedural-test",
      layers: [{ id: "three-bg", role: "background", procedural: _procedural }],
    };
    void _scene;
  });
});

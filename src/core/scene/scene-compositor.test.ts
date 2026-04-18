// src/core/scene/scene-compositor.test.ts

import { describe, expect, it } from "vitest";
import { layerStyle } from "./scene-compositor";
import type { Layer } from "./types";

describe("layerStyle", () => {
  it("applies position: absolute with inset: 0 by default", () => {
    const style = layerStyle({ id: "bg" });
    expect(style.position).toBe("absolute");
    expect(style.inset).toBe(0);
  });

  it("applies CSS filter blur when blur is set", () => {
    const style = layerStyle({ id: "bg", blur: 8 });
    expect(style.filter).toBe("blur(8px)");
  });

  it("applies blur(0px) when blur is 0 (explicit sharpness)", () => {
    const style = layerStyle({ id: "vrm", blur: 0 });
    expect(style.filter).toBe("blur(0px)");
  });

  it("omits filter when blur is not set", () => {
    const style = layerStyle({ id: "bg" });
    expect(style.filter).toBeUndefined();
  });

  it("applies backgroundColor when set", () => {
    const style = layerStyle({ id: "bg", backgroundColor: "#123456" });
    expect(style.backgroundColor).toBe("#123456");
  });

  it("omits backgroundColor when not set", () => {
    const style = layerStyle({ id: "bg" });
    expect(style.backgroundColor).toBeUndefined();
  });

  it("applies backgroundImage when set", () => {
    const layer: Layer = {
      id: "bg",
      backgroundImage: "linear-gradient(180deg, #234 0%, #123 100%)",
    };
    const style = layerStyle(layer);
    expect(style.backgroundImage).toBe("linear-gradient(180deg, #234 0%, #123 100%)");
  });

  it("combines blur / backgroundColor / backgroundImage independently", () => {
    const layer: Layer = {
      id: "bg",
      blur: 6,
      backgroundColor: "#222",
      backgroundImage: "radial-gradient(circle, #fff, transparent)",
    };
    const style = layerStyle(layer);
    expect(style.filter).toBe("blur(6px)");
    expect(style.backgroundColor).toBe("#222");
    expect(style.backgroundImage).toBe("radial-gradient(circle, #fff, transparent)");
    expect(style.position).toBe("absolute");
  });
});

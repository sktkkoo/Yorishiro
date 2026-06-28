// src/core/scene/scene-compositor.test.ts

import { describe, expect, it } from "vitest";
import { isVideoLayer, isVideoSrc, layerStyle, mediaStyle } from "./scene-compositor";
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

  it("applies CSS filter drop-shadow when dropShadow is set", () => {
    const style = layerStyle({
      id: "vrm",
      dropShadow: {
        offsetX: 6,
        offsetY: 10,
        blur: 12,
        color: "rgba(0,0,0,0.45)",
      },
    });
    expect(style.filter).toBe("drop-shadow(6px 10px 12px rgba(0,0,0,0.45))");
  });

  it("combines blur and dropShadow in CSS filter order", () => {
    const style = layerStyle({
      id: "vrm",
      blur: 6,
      dropShadow: {
        offsetX: 6,
        offsetY: 10,
        blur: 12,
        color: "rgba(0,0,0,0.45)",
      },
    });
    expect(style.filter).toBe("blur(6px) drop-shadow(6px 10px 12px rgba(0,0,0,0.45))");
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

  it("places foreground layers above the character canvas by default", () => {
    const style = layerStyle({ id: "fg", role: "foreground" });
    expect(style.zIndex).toBe(1);
  });

  it("does not add z-index to character layers by default", () => {
    const style = layerStyle({ id: "vrm-slot", role: "character" });
    expect(style.zIndex).toBeUndefined();
  });

  it("opacity が指定されている場合 style.opacity に反映する", () => {
    const result = layerStyle({ id: "test", opacity: 0.5 });
    expect(result.opacity).toBe(0.5);
  });
});

describe("isVideoSrc", () => {
  it("returns true for .webm", () => {
    expect(isVideoSrc("/path/bg.webm")).toBe(true);
  });
  it("returns true for .mp4", () => {
    expect(isVideoSrc("/path/bg.mp4")).toBe(true);
  });
  it("returns true for .mov", () => {
    expect(isVideoSrc("/path/bg.mov")).toBe(true);
  });
  it("returns true for uppercase extension (.MP4)", () => {
    expect(isVideoSrc("/path/BG.MP4")).toBe(true);
  });
  it("returns true for data video URLs", () => {
    expect(isVideoSrc("data:video/mp4;base64,AAAA")).toBe(true);
  });
  it("returns false for .jpg", () => {
    expect(isVideoSrc("/path/bg.jpg")).toBe(false);
  });
  it("returns false for .png", () => {
    expect(isVideoSrc("/path/bg.png")).toBe(false);
  });
  it("returns false for empty string", () => {
    expect(isVideoSrc("")).toBe(false);
  });
  it("returns false for URL without extension", () => {
    expect(isVideoSrc("/path/bg")).toBe(false);
  });
  it("returns false for URL with extension in query string", () => {
    expect(isVideoSrc("/path/bg.jpg?v=1")).toBe(false);
  });
});

describe("isVideoLayer", () => {
  it("uses explicit video mediaType for blob URLs", () => {
    expect(isVideoLayer({ id: "bg", src: "blob:http://localhost/video", mediaType: "video" })).toBe(
      true,
    );
  });

  it("uses explicit image mediaType even when src has video extension", () => {
    expect(isVideoLayer({ id: "bg", src: "/path/bg.mp4", mediaType: "image" })).toBe(false);
  });

  it("falls back to src extension when mediaType is omitted", () => {
    expect(isVideoLayer({ id: "bg", src: "/path/bg.webm" })).toBe(true);
  });
});

describe("mediaStyle", () => {
  it("sizes the element to cover the viewport (cqw/cqh + --media-aspect)", () => {
    const style = mediaStyle({ id: "bg" });
    expect(style.position).toBe("absolute");
    expect(style.width).toBe("max(100cqw, calc(100cqh * var(--media-aspect, 1)))");
    expect(style.height).toBe("max(100cqh, calc(100cqw / var(--media-aspect, 1)))");
  });

  it("always centers with translate(-50%, -50%) when no transform fields are set", () => {
    const style = mediaStyle({ id: "bg" });
    expect(style.transform).toBe("translate(-50%, -50%)");
  });

  it("appends translate after centering when offsetX is set (offsetY defaults to 0)", () => {
    const style = mediaStyle({ id: "bg", mediaOffsetX: 10 });
    expect(style.transform).toBe("translate(-50%, -50%) translate(10%, 0%)");
  });

  it("appends translate after centering when only offsetY is set", () => {
    const style = mediaStyle({ id: "bg", mediaOffsetY: -15 });
    expect(style.transform).toBe("translate(-50%, -50%) translate(0%, -15%)");
  });

  it("appends scale after centering when mediaScale is set", () => {
    const style = mediaStyle({ id: "bg", mediaScale: 1.5 });
    expect(style.transform).toBe("translate(-50%, -50%) scale(1.5)");
  });

  it("appends rotate after centering when mediaRotation is set", () => {
    const style = mediaStyle({ id: "bg", mediaRotation: 45 });
    expect(style.transform).toBe("translate(-50%, -50%) rotate(45deg)");
  });

  it("composes centering + translate + scale + rotate in order", () => {
    const style = mediaStyle({
      id: "bg",
      mediaOffsetX: 5,
      mediaOffsetY: -5,
      mediaScale: 2,
      mediaRotation: 90,
    });
    expect(style.transform).toBe("translate(-50%, -50%) translate(5%, -5%) scale(2) rotate(90deg)");
  });

  it("does not mutate the shared base style across calls", () => {
    const plain = mediaStyle({ id: "bg" });
    const transformed = mediaStyle({ id: "bg", mediaScale: 2 });
    expect(transformed).not.toBe(plain);
    expect(plain.transform).toBe("translate(-50%, -50%)");
  });
});

describe("layerStyle container-type for media layers", () => {
  it("adds container-type: size when the layer has a media src", () => {
    expect(layerStyle({ id: "bg", src: "/x.png" }).containerType).toBe("size");
  });

  it("omits container-type when the layer has no src", () => {
    expect(layerStyle({ id: "bg" }).containerType).toBeUndefined();
  });
});

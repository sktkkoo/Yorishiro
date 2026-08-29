import { describe, expect, it } from "vitest";
import companionManifest from "../companion/manifest.json";
import portraitManifest from "./manifest.json";
import portrait from "./ui";

describe("Call native window layout", () => {
  it("enters at the aspect-safe compact minimum and remains resizable", () => {
    expect(portrait.layout.window).toMatchObject({
      width: 200,
      height: 300,
      minWidth: 200,
      minHeight: 300,
      aspectRatio: 2 / 3,
    });
  });

  it("uses compatibility-safe ids with distinct display labels", () => {
    expect(companionManifest.id).toBe("companion");
    expect(companionManifest.viewMode.label).toBe("Portrait");
    expect(portraitManifest.id).toBe("portrait");
    expect(portraitManifest.viewMode.label).toBe("Call");
  });
});

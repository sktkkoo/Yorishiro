/**
 * makeResolveAsset の test.
 *
 * Bundled pack の relative path が build 時の bundle URL に解決されることを
 * 検証する. URL の具体値は Vite 実行時に決まるため、test では mock 表で
 * 振る舞いを確認する.
 */

import { describe, expect, it } from "vitest";
import { makeResolveAsset } from "./asset-resolver-pack";

describe("makeResolveAsset", () => {
  const mockBundledAssets: Record<string, string> = {
    "/bundled-packs/scenes/test-scene/assets/foo.glb": "/build/abc.glb",
    "/bundled-packs/scenes/test-scene/assets/bar.png": "/build/def.png",
  };

  it("resolves './assets/foo.glb' to bundled URL for bundled origin", () => {
    const resolve = makeResolveAsset({
      packId: "test-scene",
      origin: "bundled",
      bundledAssets: mockBundledAssets,
    });
    expect(resolve("./assets/foo.glb")).toBe("/build/abc.glb");
  });

  it("resolves 'assets/foo.glb' (no leading ./) to bundled URL", () => {
    const resolve = makeResolveAsset({
      packId: "test-scene",
      origin: "bundled",
      bundledAssets: mockBundledAssets,
    });
    expect(resolve("assets/foo.glb")).toBe("/build/abc.glb");
  });

  it("returns absolute URL unchanged", () => {
    const resolve = makeResolveAsset({
      packId: "test-scene",
      origin: "bundled",
      bundledAssets: mockBundledAssets,
    });
    expect(resolve("https://example.com/foo.glb")).toBe("https://example.com/foo.glb");
    expect(resolve("data:image/png;base64,xxx")).toBe("data:image/png;base64,xxx");
  });

  it("returns the relative path unchanged when not in bundle (graceful)", () => {
    const resolve = makeResolveAsset({
      packId: "test-scene",
      origin: "bundled",
      bundledAssets: mockBundledAssets,
    });
    expect(resolve("./assets/missing.glb")).toBe("./assets/missing.glb");
  });

  it("user origin: returns relative path as-is for now (deferred to user pack plan)", () => {
    const resolve = makeResolveAsset({
      packId: "test-scene",
      origin: "user",
      bundledAssets: mockBundledAssets,
    });
    expect(resolve("./assets/foo.glb")).toBe("./assets/foo.glb");
  });
});

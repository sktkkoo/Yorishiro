/**
 * makeResolveAsset の test.
 *
 * Bundled pack の relative path が build 時の bundle URL に解決されることを
 * 検証する. URL の具体値は Vite 実行時に決まるため、test では mock 表で
 * 振る舞いを確認する.
 */

import { describe, expect, it } from "vitest";
import { makeResolveAsset, makeUserResolveAsset } from "./asset-resolver-pack";

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

  it("keeps the compatibility fallback for an old user entry without an injected resolver", () => {
    const resolve = makeResolveAsset({
      packId: "test-scene",
      origin: "user",
      bundledAssets: mockBundledAssets,
    });
    expect(resolve("./assets/foo.glb")).toBe("./assets/foo.glb");
  });
});

describe("makeUserResolveAsset", () => {
  it("resolves a pack-relative path through the host converter", () => {
    const resolve = makeUserResolveAsset(
      "/Users/me/.yorishiro/packs/my-room",
      (path) => `asset://localhost${path}`,
    );

    expect(resolve("./assets/model.glb")).toBe(
      "asset://localhost/Users/me/.yorishiro/packs/my-room/assets/model.glb",
    );
  });

  it.each([
    "../other-pack/model.glb",
    "/tmp/model.glb",
    "https://example.com/model.glb",
  ])("rejects a path outside the pack boundary: %s", (path) => {
    const resolve = makeUserResolveAsset("/packs/my-room", (value) => value);
    expect(() => resolve(path)).toThrow("unsafe user pack asset path");
  });
});

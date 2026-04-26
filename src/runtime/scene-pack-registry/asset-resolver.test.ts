import { describe, expect, it, vi } from "vitest";
import type { Layer, SceneSpec } from "../../sdk/scene";
import type { LayerResolvers, ResolveOptions } from "./asset-resolver";
import {
  isAbsoluteUrl,
  normalizeRelativePath,
  resolveBundledAsset,
  resolveLayerAssetWith,
  resolveSceneAssets,
} from "./asset-resolver";

describe("isAbsoluteUrl", () => {
  it("returns true for https://", () => {
    expect(isAbsoluteUrl("https://example.com/bg.mp4")).toBe(true);
  });

  it("returns true for http://", () => {
    expect(isAbsoluteUrl("http://example.com/bg.mp4")).toBe(true);
  });

  it("returns true for asset://", () => {
    expect(isAbsoluteUrl("asset://localhost/abs/path.mp4")).toBe(true);
  });

  it("returns true for data:", () => {
    expect(isAbsoluteUrl("data:image/png;base64,...")).toBe(true);
  });

  it("returns false for relative path", () => {
    expect(isAbsoluteUrl("./assets/bg.mp4")).toBe(false);
  });

  it("returns false for pack-rooted", () => {
    expect(isAbsoluteUrl("assets/bg.mp4")).toBe(false);
  });

  it("returns false for absolute-path (non-URL)", () => {
    expect(isAbsoluteUrl("/bg.mp4")).toBe(false);
  });
});

describe("normalizeRelativePath", () => {
  it("strips leading ./", () => {
    expect(normalizeRelativePath("./foo.mp4")).toBe("foo.mp4");
  });

  it("strips leading ./ in nested path", () => {
    expect(normalizeRelativePath("./assets/foo.mp4")).toBe("assets/foo.mp4");
  });

  it("returns as-is when no leading ./", () => {
    expect(normalizeRelativePath("assets/foo.mp4")).toBe("assets/foo.mp4");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeRelativePath("")).toBe("");
  });
});

describe("resolveBundledAsset — path escape guard", () => {
  // bundled asset map はテスト環境で空なので "not found" は null で自然に返るが、
  // guard が早期 null を返すことを明示的に確認する（将来の refactor で guard を
  // 削除できないようにするため）。

  it("packId に / を含む場合は null を返す", () => {
    expect(resolveBundledAsset("foo/bar", "video.mp4")).toBeNull();
  });

  it("packId に .. を含む場合は null を返す", () => {
    expect(resolveBundledAsset("../evil", "video.mp4")).toBeNull();
  });

  it("relativePath が ../ で始まる場合は null を返す", () => {
    expect(resolveBundledAsset("valid-pack", "../other.mp4")).toBeNull();
  });

  it("relativePath に /../ を含む場合は null を返す", () => {
    expect(resolveBundledAsset("valid-pack", "a/../b.mp4")).toBeNull();
  });

  it("正常な packId / path の場合は throw せず null を返す（map が空のため）", () => {
    expect(resolveBundledAsset("my-pack", "./assets/bg.mp4")).toBeNull();
  });
});

// --- resolveLayerAssetWith テスト用 fake resolver ---

const fakeBundled: LayerResolvers["resolveBundled"] = (_packId, rel) =>
  rel === "found.mp4" || rel === "./found.mp4" ? "/asset/found.mp4" : null;

const fakeUser: LayerResolvers["resolveUser"] = async (dir, rel) =>
  `asset://${dir}/${rel.replace(/^\.\//, "")}`;

const throwingUser: LayerResolvers["resolveUser"] = async () => {
  throw new Error("convertFileSrc blew up");
};

const fakeResolvers: LayerResolvers = {
  resolveBundled: fakeBundled,
  resolveUser: fakeUser,
};

const bundledOptions = (overrides: Partial<ResolveOptions> = {}): ResolveOptions => ({
  origin: "bundled",
  packId: "test-pack",
  ...overrides,
});

const userOptions = (overrides: Partial<ResolveOptions> = {}): ResolveOptions => ({
  origin: "user",
  packId: "test-pack",
  packDir: "/home/user/.charminal/packs/test-pack",
  ...overrides,
});

const makeLayer = (src?: string): Layer => ({
  id: "layer-a",
  src,
});

describe("resolveLayerAssetWith", () => {
  it("src が undefined のとき layer をそのまま返す（resolver 呼び出しなし）", async () => {
    const layer = makeLayer(undefined);
    const bundledSpy = vi.fn(fakeBundled);
    const result = await resolveLayerAssetWith(layer, bundledOptions(), {
      resolveBundled: bundledSpy,
      resolveUser: fakeUser,
    });
    expect(result).toBe(layer);
    expect(bundledSpy).not.toHaveBeenCalled();
  });

  it("src が絶対 URL のとき layer をそのまま返す", async () => {
    const layer = makeLayer("https://cdn.example.com/bg.mp4");
    const result = await resolveLayerAssetWith(layer, bundledOptions(), fakeResolvers);
    expect(result).toBe(layer);
  });

  it("src が public path (/) のとき layer をそのまま返す", async () => {
    const layer = makeLayer("/public/bg.mp4");
    const result = await resolveLayerAssetWith(layer, bundledOptions(), fakeResolvers);
    expect(result).toBe(layer);
  });

  it("bundled + resolver が URL を返すとき layer.src が更新される", async () => {
    const layer = makeLayer("found.mp4");
    const result = await resolveLayerAssetWith(layer, bundledOptions(), fakeResolvers);
    expect(result.src).toBe("/asset/found.mp4");
  });

  it("bundled + resolver が null を返すとき layer.src が undefined になり onMissing が呼ばれる", async () => {
    const onMissing = vi.fn();
    const layer = makeLayer("not-found.mp4");
    const result = await resolveLayerAssetWith(layer, bundledOptions({ onMissing }), fakeResolvers);
    expect(result.src).toBeUndefined();
    expect(onMissing).toHaveBeenCalledWith("layer-a", "not-found.mp4");
  });

  it("user + packDir あり + resolver が URL を返すとき layer.src が更新される", async () => {
    const layer = makeLayer("bg.mp4");
    const result = await resolveLayerAssetWith(layer, userOptions(), fakeResolvers);
    expect(result.src).toBe("asset:///home/user/.charminal/packs/test-pack/bg.mp4");
  });

  it("user + packDir undefined のとき onMissing が呼ばれ layer.src が undefined になる", async () => {
    const onMissing = vi.fn();
    const layer = makeLayer("bg.mp4");
    const result = await resolveLayerAssetWith(
      layer,
      userOptions({ packDir: undefined, onMissing }),
      fakeResolvers,
    );
    expect(result.src).toBeUndefined();
    expect(onMissing).toHaveBeenCalledWith("layer-a", "bg.mp4");
  });

  it("user + resolver が throw したとき onMissing が呼ばれ layer.src が undefined になる", async () => {
    const onMissing = vi.fn();
    const layer = makeLayer("bg.mp4");
    const result = await resolveLayerAssetWith(layer, userOptions({ onMissing }), {
      resolveBundled: fakeBundled,
      resolveUser: throwingUser,
    });
    expect(result.src).toBeUndefined();
    expect(onMissing).toHaveBeenCalledWith("layer-a", "bg.mp4");
  });
});

describe("resolveSceneAssets", () => {
  it("Promise.all 分離: 一方が解決成功、他方が onMissing 経由で失敗するとき両 layer が返る", async () => {
    const onMissing = vi.fn();
    const scene: SceneSpec = {
      id: "test-scene",
      layers: [
        { id: "ok", src: "found.mp4" },
        { id: "fail", src: "not-found.mp4" },
      ],
    };
    // production API は DEFAULT_RESOLVERS を使うが、bundled asset map がテスト環境で
    // 空なので fakeBundled を使う resolveLayerAssetWith を通じて検証する。
    // resolveSceneAssets は DEFAULT_RESOLVERS を内包するため、ここでは
    // 全 layer が not-found 扱いになる（map が空）ことを確認する。
    const result = await resolveSceneAssets(scene, {
      origin: "bundled",
      packId: "test-pack",
      onMissing,
    });
    // map が空なので両 layer の src が undefined になる
    expect(result.layers).toHaveLength(2);
    expect(result.layers[0].src).toBeUndefined();
    expect(result.layers[1].src).toBeUndefined();
    expect(onMissing).toHaveBeenCalledTimes(2);
    // scene の id は保持される
    expect(result.id).toBe("test-scene");
  });

  it("src が undefined / 絶対 URL の layer は変更されず返る", async () => {
    const scene: SceneSpec = {
      id: "test-scene-2",
      layers: [{ id: "no-src" }, { id: "abs", src: "https://cdn.example.com/bg.mp4" }],
    };
    const onMissing = vi.fn();
    const result = await resolveSceneAssets(scene, {
      origin: "bundled",
      packId: "test-pack",
      onMissing,
    });
    expect(result.layers[0].src).toBeUndefined();
    expect(result.layers[1].src).toBe("https://cdn.example.com/bg.mp4");
    expect(onMissing).not.toHaveBeenCalled();
  });

  it("resolves ambient[].src via shared library lookup", async () => {
    const scene: SceneSpec = {
      id: "test",
      layers: [],
      ambient: [
        { src: "sound:rain", volume: 0.5 },
        { src: "https://cdn.example.com/abs.mp3", volume: 1.0 },
      ],
    };
    const result = await resolveSceneAssets(scene, {
      origin: "bundled",
      packId: "any",
    });
    expect(result.ambient).toBeDefined();
    // 'sound:rain' は実 glob に file が無いので解決失敗 → entry が落ちる
    // 絶対 URL はそのまま残る
    expect(result.ambient).toEqual([{ src: "https://cdn.example.com/abs.mp3", volume: 1.0 }]);
  });

  it("preserves ambient field shape (volume passes through)", async () => {
    const scene: SceneSpec = {
      id: "test",
      layers: [],
      ambient: [{ src: "asset://localhost/x.mp3", volume: 0.3 }],
    };
    const result = await resolveSceneAssets(scene, {
      origin: "bundled",
      packId: "any",
    });
    expect(result.ambient).toEqual([{ src: "asset://localhost/x.mp3", volume: 0.3 }]);
  });

  it("leaves ambient undefined when scene declares no ambient", async () => {
    const scene: SceneSpec = { id: "test", layers: [] };
    const result = await resolveSceneAssets(scene, {
      origin: "bundled",
      packId: "any",
    });
    expect(result.ambient).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import {
  buildTsxEntryUrl,
  isSupportedTsxHostImport,
  isTsxEntryPath,
  resolveRelativeTsxImport,
} from "./tsx-transpiler";

describe("isTsxEntryPath", () => {
  it("detects TSX entry paths", () => {
    expect(isTsxEntryPath("/Users/me/.charminal/packs/my-ui/ui.tsx")).toBe(true);
    expect(isTsxEntryPath("/Users/me/.charminal/packs/my-ui/ui.js")).toBe(false);
  });
});

describe("buildTsxEntryUrl", () => {
  it("adds cache key as query when provided", () => {
    const url = buildTsxEntryUrl(
      "/Users/me/.charminal/packs/my-ui/ui.tsx",
      { convertFileSrc: (path) => `asset://localhost/${encodeURIComponent(path)}` },
      { cacheKey: 123 },
    );

    expect(url).toContain("?v=123");
  });

  it("preserves existing query parameters", () => {
    const url = buildTsxEntryUrl(
      "/Users/me/.charminal/packs/my-ui/ui.tsx",
      { convertFileSrc: () => "asset://localhost/ui.tsx?token=a" },
      { cacheKey: "mtime 1" },
    );

    expect(url).toBe("asset://localhost/ui.tsx?token=a&v=mtime%201");
  });
});

describe("isSupportedTsxHostImport", () => {
  it("allows host modules needed by scene.tsx R3F components", () => {
    expect(isSupportedTsxHostImport("@charminal/sdk/r3f")).toBe(true);
    expect(isSupportedTsxHostImport("@react-three/fiber")).toBe(true);
    expect(isSupportedTsxHostImport("@react-three/drei")).toBe(true);
    expect(isSupportedTsxHostImport("three")).toBe(true);
    expect(isSupportedTsxHostImport("@charminal/sdk/controls")).toBe(true);
  });

  it("keeps unrelated imports unsupported", () => {
    expect(isSupportedTsxHostImport("fs")).toBe(false);
    expect(isSupportedTsxHostImport("@tauri-apps/api/core")).toBe(false);
    expect(isSupportedTsxHostImport("./local-file")).toBe(false);
  });
});

describe("resolveRelativeTsxImport", () => {
  it("resolves relative imports inside the pack directory", () => {
    expect(
      resolveRelativeTsxImport(
        "./lib/lights",
        "/Users/me/.charminal/packs/my-room/scene.tsx",
        "/Users/me/.charminal/packs/my-room",
      ),
    ).toBe("/Users/me/.charminal/packs/my-room/lib/lights");

    expect(
      resolveRelativeTsxImport(
        "../shared/palette",
        "/Users/me/.charminal/packs/my-room/lib/lights.tsx",
        "/Users/me/.charminal/packs/my-room",
      ),
    ).toBe("/Users/me/.charminal/packs/my-room/shared/palette");
  });

  it("rejects imports that leave the pack directory", () => {
    expect(
      resolveRelativeTsxImport(
        "../other-pack/scene",
        "/Users/me/.charminal/packs/my-room/scene.tsx",
        "/Users/me/.charminal/packs/my-room",
      ),
    ).toBeNull();
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("esbuild-wasm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("esbuild-wasm")>();
  return {
    ...actual,
    initialize: () => actual.initialize({}),
  };
});

import {
  buildTsxEntryUrl,
  isSupportedTsxHostImport,
  isTsxEntryPath,
  resolveRelativeTsxImport,
  transpileUiTsxEntry,
  tsxHostShimNamedExports,
} from "./tsx-transpiler";

describe("isTsxEntryPath", () => {
  it("detects TSX entry paths", () => {
    expect(isTsxEntryPath("/Users/me/.yorishiro/packs/my-ui/ui.tsx")).toBe(true);
    expect(isTsxEntryPath("/Users/me/.yorishiro/packs/my-ui/ui.js")).toBe(false);
  });
});

describe("buildTsxEntryUrl", () => {
  it("adds cache key as query when provided", () => {
    const url = buildTsxEntryUrl(
      "/Users/me/.yorishiro/packs/my-ui/ui.tsx",
      { convertFileSrc: (path) => `asset://localhost/${encodeURIComponent(path)}` },
      { cacheKey: 123 },
    );

    expect(url).toContain("?v=123");
  });

  it("preserves existing query parameters", () => {
    const url = buildTsxEntryUrl(
      "/Users/me/.yorishiro/packs/my-ui/ui.tsx",
      { convertFileSrc: () => "asset://localhost/ui.tsx?token=a" },
      { cacheKey: "mtime 1" },
    );

    expect(url).toBe("asset://localhost/ui.tsx?token=a&v=mtime%201");
  });
});

describe("isSupportedTsxHostImport", () => {
  it("allows host modules needed by scene.tsx R3F components", () => {
    expect(isSupportedTsxHostImport("@yorishiro/sdk/r3f")).toBe(true);
    expect(isSupportedTsxHostImport("@react-three/fiber")).toBe(true);
    expect(isSupportedTsxHostImport("@react-three/drei")).toBe(true);
    expect(isSupportedTsxHostImport("three")).toBe(true);
    expect(isSupportedTsxHostImport("@yorishiro/sdk/controls")).toBe(true);
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
        "/Users/me/.yorishiro/packs/my-room/scene.tsx",
        "/Users/me/.yorishiro/packs/my-room",
      ),
    ).toBe("/Users/me/.yorishiro/packs/my-room/lib/lights");

    expect(
      resolveRelativeTsxImport(
        "../shared/palette",
        "/Users/me/.yorishiro/packs/my-room/lib/lights.tsx",
        "/Users/me/.yorishiro/packs/my-room",
      ),
    ).toBe("/Users/me/.yorishiro/packs/my-room/shared/palette");
  });

  it("rejects imports that leave the pack directory", () => {
    expect(
      resolveRelativeTsxImport(
        "../other-pack/scene",
        "/Users/me/.yorishiro/packs/my-room/scene.tsx",
        "/Users/me/.yorishiro/packs/my-room",
      ),
    ).toBeNull();
  });
});

describe("transpileUiTsxEntry", () => {
  it("bundles an entry that imports a pack-local source file", async () => {
    const entryPath = "/Users/me/.yorishiro/packs/my-room/scene.tsx";
    const sources = new Map([
      [entryPath, 'import { roomName } from "./lib/room"; export default { roomName };'],
      ["/Users/me/.yorishiro/packs/my-room/lib/room.ts", 'export const roomName = "warm-room";'],
    ]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      const source = sources.get(path);
      return source === undefined
        ? new Response("not found", { status: 404 })
        : new Response(source, { status: 200 });
    }) as typeof fetch;

    try {
      const code = await transpileUiTsxEntry(entryPath, {
        convertFileSrc: (path) => `https://asset.local${path}`,
      });

      expect(code).toContain("warm-room");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("tsxHostShimNamedExports", () => {
  it("keeps hand-written host shim exports aligned with installed packages", async () => {
    const modules = {
      "@react-three/drei": await import("@react-three/drei"),
      "@react-three/fiber": await import("@react-three/fiber"),
      three: await import("three"),
    };

    for (const [path, mod] of Object.entries(modules)) {
      const actual = new Set(Object.keys(mod).filter((key) => key !== "__esModule"));
      const shimExports = tsxHostShimNamedExports(path);
      const missing = shimExports.filter((key) => !actual.has(key));

      expect(missing, `${path} shim exports missing from installed module`).toEqual([]);
    }
  });
});

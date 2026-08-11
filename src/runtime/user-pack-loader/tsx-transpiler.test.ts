import * as ReactThreePostprocessing from "@react-three/postprocessing";
import * as Postprocessing from "postprocessing";
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
    expect(isSupportedTsxHostImport("@react-three/postprocessing")).toBe(true);
    expect(isSupportedTsxHostImport("postprocessing")).toBe(true);
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

  it("bundles an ambient-ui.tsx entry with a nested relative source", async () => {
    const entryPath = "/Users/me/.yorishiro/packs/my-overlay/ambient-ui.tsx";
    const sources = new Map([
      [
        entryPath,
        'import { label } from "./lib/overlay"; export default { id: "my-overlay", type: "ambient-ui", label, mount() { return { dispose() {} }; } };',
      ],
      [
        "/Users/me/.yorishiro/packs/my-overlay/lib/overlay.tsx",
        'export const label = "ambient-ready";',
      ],
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

      expect(code).toContain("ambient-ready");
      expect(code).toContain("my-overlay");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("compiles and loads the post-processing authoring surface through host bridges", async () => {
    const entryPath = "/Users/me/.yorishiro/packs/post-processing-room/scene.tsx";
    const source = `
      import { EffectComposer, Bloom, Noise, Vignette } from "@react-three/postprocessing";
      import { BlendFunction, Effect, ToneMappingMode } from "postprocessing";

      export {
        EffectComposer,
        Bloom,
        Noise,
        Vignette,
        BlendFunction,
        Effect,
        ToneMappingMode,
      };
    `;
    const originalFetch = globalThis.fetch;
    const originalReactThreePostprocessing = globalThis.__YORISHIRO_REACT_THREE_POSTPROCESSING__;
    const originalPostprocessing = globalThis.__YORISHIRO_POSTPROCESSING__;
    globalThis.fetch = (async () => new Response(source, { status: 200 })) as typeof fetch;
    globalThis.__YORISHIRO_REACT_THREE_POSTPROCESSING__ = ReactThreePostprocessing;
    globalThis.__YORISHIRO_POSTPROCESSING__ = Postprocessing;

    try {
      const code = await transpileUiTsxEntry(entryPath, {
        convertFileSrc: (path) => `https://asset.local${path}`,
      });
      const moduleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
      const loaded = await import(/* @vite-ignore */ moduleUrl);

      expect(loaded.EffectComposer).toBe(ReactThreePostprocessing.EffectComposer);
      expect(loaded.Bloom).toBe(ReactThreePostprocessing.Bloom);
      expect(loaded.Noise).toBe(ReactThreePostprocessing.Noise);
      expect(loaded.Vignette).toBe(ReactThreePostprocessing.Vignette);
      expect(loaded.BlendFunction).toBe(Postprocessing.BlendFunction);
      expect(loaded.Effect).toBe(Postprocessing.Effect);
      expect(loaded.ToneMappingMode).toBe(Postprocessing.ToneMappingMode);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.__YORISHIRO_REACT_THREE_POSTPROCESSING__ = originalReactThreePostprocessing;
      globalThis.__YORISHIRO_POSTPROCESSING__ = originalPostprocessing;
    }
  });

  it("rejects an unrelated bare import through the runtime transpile path", async () => {
    const entryPath = "/Users/me/.yorishiro/packs/my-room/scene.tsx";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('import value from "unrelated-package"; export default value;', {
        status: 200,
      })) as typeof fetch;

    try {
      await expect(
        transpileUiTsxEntry(entryPath, {
          convertFileSrc: (path) => `https://asset.local${path}`,
        }),
      ).rejects.toThrow("unsupported import 'unrelated-package' in runtime-transpiled .tsx entry");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects a relative import that escapes the pack directory", async () => {
    const entryPath = "/Users/me/.yorishiro/packs/my-room/scene.tsx";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('import "../other-pack/scene"; export default {};', {
        status: 200,
      })) as typeof fetch;

    try {
      await expect(
        transpileUiTsxEntry(entryPath, {
          convertFileSrc: (path) => `https://asset.local${path}`,
        }),
      ).rejects.toThrow("relative import '../other-pack/scene' escapes the pack directory");
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
      "@react-three/postprocessing": await import("@react-three/postprocessing"),
      postprocessing: await import("postprocessing"),
      three: await import("three"),
    };

    for (const [path, mod] of Object.entries(modules)) {
      const actual = new Set(Object.keys(mod).filter((key) => key !== "__esModule"));
      const shimExports = tsxHostShimNamedExports(path);
      const missing = shimExports.filter((key) => !actual.has(key));

      expect(missing, `${path} shim exports missing from installed module`).toEqual([]);
    }
  });

  it("exposes the post-processing symbols used by local scene packs", () => {
    expect(tsxHostShimNamedExports("@react-three/postprocessing")).toEqual(
      expect.arrayContaining(["EffectComposer", "Bloom", "Noise", "Vignette"]),
    );
    expect(tsxHostShimNamedExports("postprocessing")).toEqual(
      expect.arrayContaining(["BlendFunction", "Effect", "ToneMappingMode"]),
    );
  });
});

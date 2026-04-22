import { describe, expect, it } from "vitest";
import { buildTsxEntryUrl, isTsxEntryPath } from "./tsx-transpiler";

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

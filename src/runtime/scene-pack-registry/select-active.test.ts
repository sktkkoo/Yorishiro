import { describe, expect, it } from "vitest";
import { computeActive } from "./select-active";
import type { ScenePackEntry } from "./types";

const makeEntry = (id: string, origin: "bundled" | "user"): ScenePackEntry => ({
  id,
  origin,
  manifest: {
    id,
    type: "scene",
    version: "0.1.0",
    charminalVersion: "^0.1.0",
    entry: "scene.ts",
  },
  scene: { id, layers: [] },
});

describe("computeActive", () => {
  it("returns null when no entries", () => {
    expect(computeActive([], null)).toBeNull();
  });

  it("returns bundled alphabetical first when no activeSceneId set", () => {
    const entries = [makeEntry("zzz", "bundled"), makeEntry("aaa", "bundled")];
    const result = computeActive(entries, null);
    expect(result?.id).toBe("aaa");
  });

  it("does NOT auto-select user pack when activeSceneId is null", () => {
    const entries = [makeEntry("user-a", "user"), makeEntry("bundled-b", "bundled")];
    const result = computeActive(entries, null);
    expect(result?.origin).toBe("bundled");
  });

  it("returns the pack whose id matches activeSceneId", () => {
    const entries = [makeEntry("bundled-a", "bundled"), makeEntry("user-b", "user")];
    const result = computeActive(entries, "user-b");
    expect(result?.id).toBe("user-b");
  });

  it("falls through to bundled fallback when activeSceneId does not exist", () => {
    const entries = [makeEntry("bundled-a", "bundled")];
    const result = computeActive(entries, "missing-id");
    expect(result?.id).toBe("bundled-a");
  });

  it("returns null when no bundled pack exists and activeSceneId is null", () => {
    const entries = [makeEntry("user-only", "user")];
    const result = computeActive(entries, null);
    expect(result).toBeNull();
  });
});

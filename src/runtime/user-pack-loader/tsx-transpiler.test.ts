import { describe, expect, it } from "vitest";
import { isTsxEntryPath } from "./tsx-transpiler";

describe("isTsxEntryPath", () => {
  it("detects TSX entry paths", () => {
    expect(isTsxEntryPath("/Users/me/.charminal/packs/my-ui/ui.tsx")).toBe(true);
    expect(isTsxEntryPath("/Users/me/.charminal/packs/my-ui/ui.js")).toBe(false);
  });
});

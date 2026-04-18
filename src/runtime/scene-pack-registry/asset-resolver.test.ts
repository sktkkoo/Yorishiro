import { describe, expect, it } from "vitest";
import { isAbsoluteUrl, normalizeRelativePath } from "./asset-resolver";

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

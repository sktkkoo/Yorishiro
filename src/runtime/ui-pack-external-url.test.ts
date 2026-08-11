import { describe, expect, it } from "vitest";
import { UI_PACK_EXTERNAL_URL_MAX_LENGTH, validateUiPackExternalUrl } from "./ui-pack-external-url";

describe("validateUiPackExternalUrl", () => {
  it("accepts and normalizes absolute HTTPS URLs", () => {
    expect(validateUiPackExternalUrl("https://example.com/docs?q=pack#ui")).toBe(
      "https://example.com/docs?q=pack#ui",
    );
  });

  it.each([
    "http://example.com",
    "file:///tmp/example",
    "mailto:author@example.com",
    "yorishiro://settings",
    "/relative/path",
    "https://user:secret@example.com",
    " https://example.com",
    "https://example.com ",
  ])("rejects URLs outside the public Pack boundary: %s", (url) => {
    expect(() => validateUiPackExternalUrl(url)).toThrow();
  });

  it("rejects empty and oversized values", () => {
    expect(() => validateUiPackExternalUrl("")).toThrow();
    expect(() =>
      validateUiPackExternalUrl(
        `https://example.com/${"x".repeat(UI_PACK_EXTERNAL_URL_MAX_LENGTH)}`,
      ),
    ).toThrow();
  });
});

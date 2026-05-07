import { describe, expect, it } from "vitest";
import { detectLanguage, resolveLanguage, toAppLanguage } from "./language";

describe("language", () => {
  it("parses supported app language values", () => {
    expect(toAppLanguage("auto")).toBe("auto");
    expect(toAppLanguage("en")).toBe("en");
    expect(toAppLanguage("ja")).toBe("ja");
  });

  it("falls back to auto for unsupported values", () => {
    expect(toAppLanguage("fr")).toBe("auto");
    expect(toAppLanguage(null)).toBe("auto");
    expect(toAppLanguage(1)).toBe("auto");
  });

  it("detects Japanese from the first locale", () => {
    expect(detectLanguage(["ja-JP", "en-US"])).toBe("ja");
    expect(detectLanguage("ja")).toBe("ja");
  });

  it("falls back to English when the first locale is not Japanese", () => {
    expect(detectLanguage(["fr-FR", "ja-JP"])).toBe("en");
    expect(detectLanguage([])).toBe("en");
    expect(detectLanguage(null)).toBe("en");
  });

  it("explicit language wins over detection", () => {
    expect(resolveLanguage("en", ["ja-JP"])).toBe("en");
    expect(resolveLanguage("ja", ["en-US"])).toBe("ja");
    expect(resolveLanguage("auto", ["ja-JP"])).toBe("ja");
  });
});

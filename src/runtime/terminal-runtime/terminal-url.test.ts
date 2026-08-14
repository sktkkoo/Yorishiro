import { describe, expect, it } from "vitest";
import { findHttpUrlAtTextOffset } from "./terminal-url";

describe("findHttpUrlAtTextOffset", () => {
  it.each([
    ["Docs: https://example.com/path?q=one#intro", 12, "https://example.com/path?q=one#intro"],
    ["Local: http://localhost:5173/", 15, "http://localhost:5173/"],
    ["(https://example.com/docs).", 10, "https://example.com/docs"],
    ["https://example.com/a_(b)", 22, "https://example.com/a_(b)"],
  ])("returns the HTTP(S) URL under the clicked offset", (text, offset, expected) => {
    expect(findHttpUrlAtTextOffset(text, offset)).toBe(expected);
  });

  it("chooses between multiple links using the clicked offset", () => {
    const text = "https://one.example or https://two.example/docs";

    expect(findHttpUrlAtTextOffset(text, 10)).toBe("https://one.example");
    expect(findHttpUrlAtTextOffset(text, 35)).toBe("https://two.example/docs");
  });

  it.each([
    ["prefix https://example.com suffix", 2],
    ["prefix https://example.com suffix", 29],
    ["javascript:alert(1)", 5],
    ["file:///tmp/report.html", 10],
    ["nothttps://example.com", 8],
    ["https://exa mple.com", 15],
  ])("rejects non-link offsets and unsupported or malformed URLs", (text, offset) => {
    expect(findHttpUrlAtTextOffset(text, offset)).toBeNull();
  });
});

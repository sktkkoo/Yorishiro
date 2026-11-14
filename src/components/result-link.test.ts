import { describe, expect, it } from "vitest";
import { resultLink, resultTextParts } from "./result-link";

describe("result URLs", () => {
  it("normalizes web destinations while preserving link display text", () => {
    expect(resultLink("HTTPS://example.com/日本語?q=1#result")).toBe(
      "https://example.com/%E6%97%A5%E6%9C%AC%E8%AA%9E?q=1#result",
    );
    expect(resultLink("http://localhost:3000/result")).toBe("http://localhost:3000/result");
  });
  it.each([
    null,
    undefined,
    "",
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///tmp/result",
    "mailto:hello@example.com",
    "//example.com",
    "https://user:secret@example.com/result",
    "https://@example.com",
    "https:///example.com",
    "http:////example.com",
    "https://example.com\\other",
    " https://example.com",
    "https://example.com/with space",
    "https://exa\nmple.com",
  ])("rejects unsafe or ambiguous destinations: %s", (value) => {
    expect(resultLink(value)).toBeNull();
  });
  it("keeps long unmatched bracket suffixes outside a balanced URL", () => {
    const url = "https://example.com/result_(one)";
    const suffix = ")".repeat(20_000);
    expect(resultTextParts(url + suffix)).toEqual([
      { text: url, url },
      { text: suffix, url: null },
    ]);
  });
  it.each([
    ["PR: https://github.com/team/repo/pull/12.\nDone!", ["https://github.com/team/repo/pull/12"]],
    [
      "結果はこちら：https://example.com/result。次はこちら「https://example.com/next」。",
      ["https://example.com/result", "https://example.com/next"],
    ],
    [
      "(https://en.wikipedia.org/wiki/Function_(mathematics)).",
      ["https://en.wikipedia.org/wiki/Function_(mathematics)"],
    ],
    [
      "[PR](https://example.com/pull/2), https://example.com/check?x=1&y=2#done!",
      ["https://example.com/pull/2", "https://example.com/check?x=1&y=2#done"],
    ],
    [
      "（https://example.com/path） https://[::1]/result;",
      ["https://example.com/path", "https://[::1]/result"],
    ],
    [
      "javascript:https://example.com ftp://https://example.com https://user:secret@example.com/https://other.example/result",
      [],
    ],
    ["No link here\n<img src=x onerror=alert(1)>", []],
  ] as const)("separates only safe literal links and reconstructs the exact text: %s", (text, links) => {
    const parts = resultTextParts(text);
    expect(parts.map((part) => part.text).join("")).toBe(text);
    expect(parts.filter((part) => part.url).map((part) => part.text)).toEqual(links);
  });
});

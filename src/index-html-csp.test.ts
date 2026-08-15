import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

describe("index.html CSP compatibility", () => {
  it("keeps boot styles in an external stylesheet", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const document = new JSDOM(html).window.document;

    expect(document.querySelectorAll("style")).toHaveLength(0);
    expect(document.querySelector('link[rel="stylesheet"][href="/boot.css"]')).not.toBeNull();
  });
});

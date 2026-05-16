import { describe, expect, it } from "vitest";
import { checkPackFiles, isSafePackRelativePath } from "./pack-checker.mjs";

const files = (entries) => new Map(entries);

describe("checkPackFiles", () => {
  it("accepts local trusted authoring packs with a warning", () => {
    const result = checkPackFiles({
      packDirName: "my-effect",
      files: files([
        [
          "manifest.json",
          JSON.stringify({
            id: "my-effect",
            type: "effect",
            executionClass: "trusted-main-thread-js",
            entry: "effect.js",
          }),
        ],
        ["effect.js", "export default { id: 'my-effect', type: 'effect' };"],
      ]),
    });

    expect(result.ok).toBe(true);
    expect(result.warnings.map((diagnostic) => diagnostic.code)).toContain("local-trusted-pack");
  });

  it("rejects trusted-main-thread-js for publish candidates", () => {
    const result = checkPackFiles({
      mode: "publish-candidate",
      packDirName: "my-effect",
      files: files([
        [
          "manifest.json",
          JSON.stringify({
            id: "my-effect",
            type: "effect",
            executionClass: "trusted-main-thread-js",
            entry: "effect.js",
          }),
        ],
        ["effect.js", "export default { id: 'my-effect', type: 'effect' };"],
      ]),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((diagnostic) => diagnostic.code)).toContain(
      "trusted-main-thread-publish",
    );
  });

  it("rejects declarative packs with JS entries", () => {
    const result = checkPackFiles({
      packDirName: "my-scene",
      files: files([
        [
          "manifest.json",
          JSON.stringify({
            id: "my-scene",
            type: "scene",
            executionClass: "declarative",
            entry: "scene.js",
          }),
        ],
        ["scene.js", "export default {};"],
      ]),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((diagnostic) => diagnostic.code)).toContain("declarative-js-entry");
  });

  it("rejects unsafe URLs and forbidden APIs in source files", () => {
    const result = checkPackFiles({
      packDirName: "bad-scene",
      files: files([
        [
          "manifest.json",
          JSON.stringify({
            id: "bad-scene",
            type: "scene",
            executionClass: "trusted-main-thread-js",
            entry: "scene.js",
          }),
        ],
        ["scene.js", "fetch('https://example.com/bg.png');"],
      ]),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(["unsafe-url", "forbidden-fetch"]),
    );
  });

  it("rejects prototype pollution keys in manifest JSON", () => {
    const result = checkPackFiles({
      packDirName: "bad-pack",
      files: files([
        [
          "manifest.json",
          `{
            "id": "bad-pack",
            "type": "effect",
            "executionClass": "trusted-main-thread-js",
            "entry": "effect.js",
            "__proto__": { "polluted": true }
          }`,
        ],
        ["effect.js", "export default {};"],
      ]),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((diagnostic) => diagnostic.code)).toContain("prototype-pollution-key");
  });
});

describe("isSafePackRelativePath", () => {
  it("accepts pack-relative paths only", () => {
    expect(isSafePackRelativePath("./assets/bg.png")).toBe(true);
    expect(isSafePackRelativePath("assets/bg.png")).toBe(true);
    expect(isSafePackRelativePath("../secret.txt")).toBe(false);
    expect(isSafePackRelativePath("/tmp/bg.png")).toBe(false);
    expect(isSafePackRelativePath("https://example.com/bg.png")).toBe(false);
    expect(isSafePackRelativePath("data:text/html,<script></script>")).toBe(false);
  });
});

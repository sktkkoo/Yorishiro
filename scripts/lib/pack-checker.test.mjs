import { describe, expect, it } from "vitest";
import {
  checkPackFiles,
  createPackBinaryFile,
  createPackSymlinkFile,
  createPackTextFile,
  isSafePackRelativePath,
  MAX_PACK_FILE_BYTES,
  MAX_TEXT_FILE_BYTES,
  shouldReadPackTextFile,
} from "./pack-checker.mjs";

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
    expect(result.warnings.map((diagnostic) => diagnostic.code)).toContain(
      "publish-candidate-preview",
    );
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
        ["scene.js", "fetch('https://example.com/bg.png'); const href = 'javascript:alert(1)';"],
      ]),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(["unsafe-url", "forbidden-fetch"]),
    );
  });

  it("does not hard reject natural-language URLs in persona markdown", () => {
    const result = checkPackFiles({
      packDirName: "my-persona",
      files: files([
        [
          "manifest.json",
          JSON.stringify({
            id: "my-persona",
            type: "persona",
            executionClass: "trusted-main-thread-js",
            entry: "persona.js",
          }),
        ],
        ["persona.js", "export default { id: 'my-persona', name: 'My Persona' };"],
        [
          "persona.md",
          "Reference: https://example.com/style-guide. Avoid ../ as prose, not a path.",
        ],
      ]),
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
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

  it("checks binary metadata without requiring binary contents", () => {
    const result = checkPackFiles({
      packDirName: "my-scene",
      files: files([
        [
          "manifest.json",
          JSON.stringify({
            id: "my-scene",
            type: "scene",
            executionClass: "trusted-main-thread-js",
            entry: "scene.js",
          }),
        ],
        ["scene.js", "export default { id: 'my-scene', type: 'scene' };"],
        ["assets/bg.png", createPackBinaryFile(1024)],
      ]),
    });

    expect(result.ok).toBe(true);
  });

  it("rejects symlinks and oversized files", () => {
    const result = checkPackFiles({
      packDirName: "my-scene",
      files: files([
        [
          "manifest.json",
          JSON.stringify({
            id: "my-scene",
            type: "scene",
            executionClass: "trusted-main-thread-js",
            entry: "scene.js",
          }),
        ],
        ["scene.js", "export default { id: 'my-scene', type: 'scene' };"],
        ["assets/link.png", createPackSymlinkFile()],
        ["assets/huge.mp4", createPackBinaryFile(MAX_PACK_FILE_BYTES + 1)],
        ["notes.txt", createPackBinaryFile(MAX_TEXT_FILE_BYTES + 1)],
      ]),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(["symlink-entry", "file-too-large", "text-file-too-large"]),
    );
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

describe("shouldReadPackTextFile", () => {
  it("limits text reads by extension and size", () => {
    expect(shouldReadPackTextFile("scene.js", MAX_TEXT_FILE_BYTES)).toBe(true);
    expect(shouldReadPackTextFile("scene.js", MAX_TEXT_FILE_BYTES + 1)).toBe(false);
    expect(shouldReadPackTextFile("assets/bg.png", 128)).toBe(false);
    expect(createPackTextFile("ok").kind).toBe("text");
  });
});

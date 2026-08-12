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
  const systemExecPack = ({
    type = "amenity",
    executionClass = "trusted-main-thread-js",
    source = "export default { activate: (ctx) => ctx.system.exec('date') };",
  } = {}) =>
    files([
      [
        "manifest.json",
        JSON.stringify({
          id: "exec-pack",
          type,
          executionClass,
          entry: `${type}.js`,
        }),
      ],
      [`${type}.js`, source],
    ]);

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

  it("allows system.exec only for local trusted-main-thread amenity authoring", () => {
    const result = checkPackFiles({
      mode: "local-authoring",
      packDirName: "exec-pack",
      files: systemExecPack(),
    });

    expect(result.errors.map((diagnostic) => diagnostic.code)).not.toContain(
      "forbidden-system-exec",
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    "persona",
    "effect",
    "scene",
    "ui",
    "ambient-ui",
  ])("rejects system.exec for local %s packs", (type) => {
    const result = checkPackFiles({
      mode: "local-authoring",
      packDirName: "exec-pack",
      files: systemExecPack({ type }),
    });

    expect(result.errors.map((diagnostic) => diagnostic.code)).toContain("forbidden-system-exec");
  });

  it("rejects system.exec for publish-candidate amenities", () => {
    const result = checkPackFiles({
      mode: "publish-candidate",
      packDirName: "exec-pack",
      files: systemExecPack(),
    });

    expect(result.errors.map((diagnostic) => diagnostic.code)).toContain("forbidden-system-exec");
  });

  it.each([
    "isolated-js",
    "declarative",
  ])("rejects system.exec for local amenities with %s execution", (executionClass) => {
    const result = checkPackFiles({
      mode: "local-authoring",
      packDirName: "exec-pack",
      files: systemExecPack({ executionClass }),
    });

    expect(result.errors.map((diagnostic) => diagnostic.code)).toContain("forbidden-system-exec");
  });

  it("ignores forbidden-looking process access inside strings and comments", () => {
    const result = checkPackFiles({
      packDirName: "exec-pack",
      files: systemExecPack({
        source: `
          const stdoutHint = "process.stdout";
          const templateHint = \`process.stderr\`;
          // process.exit(1)
          /* process.env.SECRET */
          export default { stdoutHint, templateHint };
        `,
      }),
    });

    expect(result.errors.map((diagnostic) => diagnostic.code)).not.toContain("forbidden-process");
  });

  it("ignores system.exec inside strings and comments", () => {
    const result = checkPackFiles({
      packDirName: "exec-pack",
      files: systemExecPack({
        type: "scene",
        source: `
          const migrationHint = "use ctx.system.exec only from an amenity";
          // ctx.system.exec("date")
          /* system.exec("date") */
          export default { migrationHint };
        `,
      }),
    });

    expect(result.errors.map((diagnostic) => diagnostic.code)).not.toContain(
      "forbidden-system-exec",
    );
  });

  it("still rejects executable process property access", () => {
    const result = checkPackFiles({
      packDirName: "exec-pack",
      files: systemExecPack({ source: "export default process.stdout;" }),
    });

    expect(result.errors.map((diagnostic) => diagnostic.code)).toContain("forbidden-process");
  });

  it.each([
    "globalThis.process.stdout",
    "window.process.stdout",
    "(process).stdout",
  ])("preserves forbidden process detection for %s", (expression) => {
    const result = checkPackFiles({
      packDirName: "exec-pack",
      files: systemExecPack({ source: `export default ${expression};` }),
    });

    expect(result.errors.map((diagnostic) => diagnostic.code)).toContain("forbidden-process");
  });

  it("still rejects process access inside a template expression", () => {
    const source = ["export default `", "$", "{process.stdout}`;"].join("");
    const result = checkPackFiles({
      packDirName: "exec-pack",
      files: systemExecPack({ source }),
    });

    expect(result.errors.map((diagnostic) => diagnostic.code)).toContain("forbidden-process");
  });

  it("keeps conservative forbidden API scanning for HTML", () => {
    const result = checkPackFiles({
      packDirName: "exec-pack",
      files: files([
        [
          "manifest.json",
          JSON.stringify({
            id: "exec-pack",
            type: "amenity",
            executionClass: "trusted-main-thread-js",
            entry: "amenity.js",
          }),
        ],
        ["amenity.js", "export default {};"],
        ["panel.html", '<button onclick="process.exit(1)">Stop</button>'],
      ]),
    });

    expect(result.errors.map((diagnostic) => diagnostic.code)).toContain("forbidden-process");
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

  it("allows a nested source import that remains inside the pack", () => {
    const result = checkPackFiles({
      packDirName: "my-scene",
      files: files([
        [
          "manifest.json",
          JSON.stringify({
            id: "my-scene",
            type: "scene",
            executionClass: "trusted-main-thread-js",
            entry: "scene.tsx",
          }),
        ],
        ["scene.tsx", 'import { view } from "./lib/view"; export default view;'],
        ["lib/view.ts", 'export { theme as view } from "../theme";'],
        ["theme.ts", "export const theme = {};"],
      ]),
    });

    expect(result.ok).toBe(true);
    expect(result.errors.map((diagnostic) => diagnostic.code)).not.toContain("path-traversal");
  });

  it("still rejects relative imports and asset strings that escape the pack", () => {
    const importResult = checkPackFiles({
      packDirName: "bad-scene",
      files: files([
        [
          "manifest.json",
          JSON.stringify({
            id: "bad-scene",
            type: "scene",
            executionClass: "trusted-main-thread-js",
            entry: "scene.tsx",
          }),
        ],
        ["scene.tsx", 'import "../other-pack/scene"; export default {};'],
      ]),
    });
    const assetResult = checkPackFiles({
      packDirName: "bad-scene",
      files: files([
        [
          "manifest.json",
          JSON.stringify({
            id: "bad-scene",
            type: "scene",
            executionClass: "trusted-main-thread-js",
            entry: "scene.tsx",
          }),
        ],
        ["scene.tsx", 'export default { src: "../secret.png" };'],
      ]),
    });

    expect(importResult.errors.map((diagnostic) => diagnostic.code)).toContain("path-traversal");
    expect(assetResult.errors.map((diagnostic) => diagnostic.code)).toContain("path-traversal");
  });

  it("rejects forbidden APIs hidden in HTML assets", () => {
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
        ["assets/overlay.html", "<div><script>eval(atob('ZmV0Y2g='))</script></div>"],
      ]),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((diagnostic) => diagnostic.code)).toContain("forbidden-eval");
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

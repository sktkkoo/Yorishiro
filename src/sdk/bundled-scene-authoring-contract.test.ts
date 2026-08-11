import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const bundledScenesRoot = join(import.meta.dirname, "../../bundled-packs/scenes");

async function collectSourcePaths(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return collectSourcePaths(path);
      return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
    }),
  );
  return paths.flat();
}

describe("bundled scene authoring contract", () => {
  it("imports useControlsBridge from the public controls SDK", async () => {
    const sourcePaths = await collectSourcePaths(bundledScenesRoot);
    const failures: string[] = [];

    for (const sourcePath of sourcePaths) {
      const source = await readFile(sourcePath, "utf8");
      if (!source.includes("useControlsBridge(")) continue;

      const importsPublicBridge =
        /import\s*\{[^}]*\buseControlsBridge\b[^}]*\}\s*from\s*["']@yorishiro\/sdk\/controls["']/.test(
          source,
        );
      if (!importsPublicBridge) {
        failures.push(relative(bundledScenesRoot, sourcePath));
      }
    }

    expect(failures).toEqual([]);
  });
});

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parsePackManifest } from "@yorishiro/pack-schema";
import { describe, expect, it } from "vitest";

const bundledPacksRoot = join(import.meta.dirname, "../../bundled-packs");

async function collectManifestPaths(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return collectManifestPaths(path);
      return entry.name === "manifest.json" ? [path] : [];
    }),
  );
  return paths.flat();
}

describe("bundled pack manifest schema conformance", () => {
  it("validates every bundled manifest against the store schema", async () => {
    const manifestPaths = await collectManifestPaths(bundledPacksRoot);
    expect(manifestPaths.length).toBeGreaterThan(0);

    const failures: string[] = [];
    for (const manifestPath of manifestPaths) {
      const input: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
      const result = parsePackManifest(input);
      if (!result.ok) {
        failures.push(
          `${relative(bundledPacksRoot, manifestPath)}: ${result.errors.join(
            "; ",
          )}`,
        );
      }
    }

    expect(failures).toEqual([]);
  });
});

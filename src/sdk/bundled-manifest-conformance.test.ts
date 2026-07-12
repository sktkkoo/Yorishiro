import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { AnySchemaObject } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

const bundledPacksRoot = join(import.meta.dirname, "../../bundled-packs");
const schemaPath = join(import.meta.dirname, "vendor/pack-manifest.schema.json");

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
  it("validates every bundled manifest against the vendored store schema", async () => {
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as AnySchemaObject;
    // strict:false — このテストは manifest の妥当性検査であって schema 自体の lint ではない。
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);

    const manifestPaths = await collectManifestPaths(bundledPacksRoot);
    expect(manifestPaths.length).toBeGreaterThan(0);

    const failures: string[] = [];
    for (const manifestPath of manifestPaths) {
      const input: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
      if (!validate(input)) {
        const errors = (validate.errors ?? [])
          .map((error) => `${error.instancePath || "/"} ${error.message}`)
          .join("; ");
        failures.push(`${relative(bundledPacksRoot, manifestPath)}: ${errors}`);
      }
    }

    expect(failures).toEqual([]);
  });
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../..");
const rustSourcePath = join(repoRoot, "src-tauri/src/lib.rs");

function isModuleStatementStart(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith("import ") ||
    trimmed.startsWith("export *") ||
    trimmed.startsWith("export type {") ||
    trimmed.startsWith("export {")
  );
}

function flattenSdkPart(source: string): string {
  const output: string[] = [];
  let statement: string[] | null = null;

  for (const line of source.split("\n")) {
    if (statement !== null) {
      statement.push(line);
      if (line.trimEnd().endsWith(";")) {
        const joined = statement.join("\n");
        if (!joined.includes('from "./') && !joined.includes("from './")) output.push(joined);
        statement = null;
      }
      continue;
    }
    if (isModuleStatementStart(line)) {
      if (line.trimEnd().endsWith(";")) {
        if (!line.includes('from "./') && !line.includes("from './")) output.push(line);
      } else {
        statement = [line];
      }
      continue;
    }
    output.push(line);
  }
  if (statement !== null) output.push(statement.join("\n"));
  return output.join("\n");
}

async function buildDistributedSdkDts(): Promise<string> {
  const rustSource = await readFile(rustSourcePath, "utf8");
  const partsBlock = rustSource.match(
    /const SDK_DTS_PARTS: &\[\(&str, &str\)\] = &\[([\s\S]*?)\n\];/,
  )?.[1];
  expect(partsBlock, "SDK_DTS_PARTS must be present").toBeDefined();

  const partNames = Array.from(
    partsBlock?.matchAll(/include_str!\("\.\.\/\.\.\/src\/sdk\/([^"\n]+)"\)/g) ?? [],
    (match) => match[1],
  );
  expect(partNames).toContain("amenity-service.d.ts");

  const chunks: string[] = [];
  for (const partName of partNames) {
    const source = await readFile(join(repoRoot, "src/sdk", partName), "utf8");
    chunks.push(flattenSdkPart(source));
  }
  return chunks.join("\n\n");
}

describe("distributed sdk.d.ts", () => {
  it("includes the amenity service envelope without unresolved type references", async () => {
    const bundle = await buildDistributedSdkDts();
    const tempDir = await mkdtemp(join(repoRoot, ".sdk-dts-test-"));
    const bundlePath = join(tempDir, "sdk.d.ts");

    try {
      await writeFile(bundlePath, bundle);
      const program = ts.createProgram([bundlePath], {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
        skipLibCheck: false,
        strict: true,
        target: ts.ScriptTarget.ES2020,
      });
      const diagnostics = ts
        .getPreEmitDiagnostics(program)
        .filter((diagnostic) => diagnostic.file?.fileName === bundlePath);
      const messages = diagnostics.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      );

      expect(bundle).toContain("export interface AmenityServiceHandle");
      expect(bundle).toContain("export interface AmenityServicesAPI");
      expect(messages).toEqual([]);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  }, 20_000);
});

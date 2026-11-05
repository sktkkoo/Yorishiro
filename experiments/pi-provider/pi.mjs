import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Reuse the sibling experiment's exact-version installation; no global lookup.
const require = createRequire(new URL("../pi-harness/package.json", import.meta.url));
export async function createPiModels(credentials) {
  // Pi exports only ESM import entries; select those documented exports rather
  // than asking the CommonJS resolver to load an import-only package root.
  const manifestPath = require.resolve("./node_modules/@earendil-works/pi-ai/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== "1.5.0") throw new Error("Expected pinned pi-ai@1.5.0");
  const entry = (path) => pathToFileURL(resolve(dirname(manifestPath), path));
  const { createModels } = await import(entry(manifest.exports["."].import));
  const { openaiProvider } = await import(
    entry(manifest.exports["./providers/*"].import.replace("*", "openai"))
  );
  const models = createModels({
    credentials,
    // This driver intentionally ignores inherited environment/API-key discovery.
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  models.setProvider(openaiProvider());
  return models;
}

export const driverPath = fileURLToPath(new URL("driver.mjs", import.meta.url));

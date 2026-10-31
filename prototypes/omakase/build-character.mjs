#!/usr/bin/env node
import { access, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
/** Build the LOCAL ONLY embedded character preview. Do not publish the output. */
import { build } from "esbuild";

const directory = dirname(fileURLToPath(import.meta.url));
const model = resolve(directory, "../../public/models/Yori.vrm");
const idle = resolve(directory, "../../public/animations/Idle.vrma");
const outfile = resolve(directory, "character.bundle.js");
for (const file of [model, idle]) {
  try {
    await access(file);
  } catch {
    throw new Error(`Missing local asset: ${file}. Run the repository's asset setup first.`);
  }
}
await build({
  entryPoints: [resolve(directory, "character.js")],
  outfile,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  loader: { ".vrm": "base64", ".vrma": "base64" },
  minify: true,
  legalComments: "inline",
  banner: {
    js: "/* LOCAL YORISHIRO UX PREVIEW ONLY. Contains licensed VRM/VRMA assets. Do not publish or redistribute. Rebuild: node prototypes/omakase/build-character.mjs */",
  },
});
const bytes = (await stat(outfile)).size;
console.log(`Built local character preview (${(bytes / 1024 / 1024).toFixed(1)} MiB).`);
console.log("Generated bundle is gitignored and is for local use only.");

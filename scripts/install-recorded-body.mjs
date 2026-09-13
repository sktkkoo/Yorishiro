#!/usr/bin/env node
/** Install the explicitly reviewed target-specific units; keep source originals intact.
 * node scripts/install-recorded-body.mjs [prepared-dir] [asset-store]
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prepared = path.resolve(
  process.argv[2] ?? path.join(root, ".motion-review/source-assets/prepared"),
);
const store = path.resolve(
  process.argv[3] ?? process.env.YORISHIRO_ASSETS_DIR ?? path.join(root, "..", "Yorishiro-assets"),
);
const manifest = JSON.parse(
  await readFile(path.join(root, "docs/decisions/recorded-body-bundle.json"), "utf8"),
);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (
  manifest.schemaVersion !== 1 ||
  !Array.isArray(manifest.recordings) ||
  !Array.isArray(manifest.units)
)
  throw new Error("Invalid reviewed bundle");
const model = await readFile(path.join(store, "models/Yori.vrm"));
if (sha256(model) !== manifest.targetModelSha256)
  throw new Error("Bundle was not reviewed on the installed Yori model");
const files = await Promise.all(
  manifest.recordings.map(async (recording) => {
    if (
      path.basename(recording.sourceFile) !== recording.sourceFile ||
      !/^[A-Za-z0-9_-]+\.vrma$/.test(recording.file)
    )
      throw new Error("Invalid recording path");
    const bytes = await readFile(path.join(prepared, recording.sourceFile));
    if (sha256(bytes) !== recording.sha256)
      throw new Error(`Recording differs from reviewed bytes: ${recording.sourceFile}`);
    return { ...recording, bytes };
  }),
);
for (const unit of manifest.units) {
  if (!files.some((file) => unit.animation === `/animations/recorded-body/${file.file}`))
    throw new Error(`Unit references an unreviewed recording: ${unit.id}`);
}
const directory = path.join(store, "animations/recorded-body");
await mkdir(directory, { recursive: true });
for (const file of files) await writeFile(path.join(directory, file.file), file.bytes);
// Write admission metadata last, after every approved binary is in place.
await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `Installed ${manifest.units.length} reviewed body units from ${files.length} recordings at ${directory}`,
);

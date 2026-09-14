#!/usr/bin/env node
/** Install the reviewed Mixamo conversions in the private asset store.
 * node scripts/install-mixamo-recordings.mjs [prepared-directory] [asset-store]
 * Source FBX files remain in asset-store/sources; no source files are modified.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reviewPath = path.join(root, "docs/decisions/mixamo-motion-review.json");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function readReview() {
  const review = JSON.parse(await readFile(reviewPath, "utf8"));
  if (review.schemaVersion !== 1 || !Array.isArray(review.recordings)) {
    throw new Error("Unsupported Mixamo review manifest");
  }
  const names = new Set();
  for (const entry of review.recordings) {
    if (
      typeof entry.file !== "string" ||
      path.basename(entry.file) !== entry.file ||
      !entry.file.endsWith(".vrma") ||
      typeof entry.sourceFile !== "string" ||
      path.basename(entry.sourceFile) !== entry.sourceFile ||
      !entry.sourceFile.toLowerCase().endsWith(".fbx") ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !/^[a-f0-9]{64}$/.test(entry.sourceSha256) ||
      !["contextual", "occasional", "manual-only", "excluded"].includes(entry.usage) ||
      names.has(entry.file)
    ) {
      throw new Error(`Invalid Mixamo review entry: ${entry.file}`);
    }
    names.add(entry.file);
  }
  return review;
}

/** Missing optional clips are allowed; changed bytes must be reviewed again. */
export async function verifyInstalledMixamoRecordings(directory) {
  const review = await readReview();
  for (const entry of review.recordings) {
    let bytes;
    try {
      bytes = await readFile(path.join(directory, entry.file));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (entry.usage === "excluded" || hash(bytes) !== entry.sha256) {
      throw new Error(`Unreviewed Mixamo recording: ${entry.file}`);
    }
  }
}

async function main() {
  const prepared = path.resolve(
    process.argv[2] ?? path.join(root, ".motion-review/mixamo-import-20260915"),
  );
  const store = path.resolve(
    process.argv[3] ??
      process.env.YORISHIRO_ASSETS_DIR ??
      path.join(root, "..", "Yorishiro-assets"),
  );
  const review = await readReview();
  // Validate every original and conversion before creating or replacing files.
  const recordings = await Promise.all(
    review.recordings
      .filter((entry) => entry.usage !== "excluded")
      .map(async (entry) => {
        const [source, bytes] = await Promise.all([
          readFile(path.join(store, "sources", entry.sourceFile)),
          readFile(path.join(prepared, entry.file)),
        ]);
        if (hash(source) !== entry.sourceSha256 || hash(bytes) !== entry.sha256) {
          throw new Error(`Mixamo source or conversion hash mismatch: ${entry.file}`);
        }
        return { entry, bytes };
      }),
  );
  const destination = path.join(store, "animations", "mixamo");
  await mkdir(destination, { recursive: true });
  for (const { entry, bytes } of recordings) {
    await writeFile(path.join(destination, entry.file), bytes);
  }
  await writeFile(path.join(destination, "manifest.json"), `${JSON.stringify(review, null, 2)}\n`);
  console.log(`Installed ${recordings.length} reviewed Mixamo recordings at ${destination}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

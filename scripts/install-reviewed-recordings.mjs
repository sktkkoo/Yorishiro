#!/usr/bin/env node
/** Install reviewed 30 Hz recordings beside, never over, the original asset store.
 * node scripts/install-reviewed-recordings.mjs [prepared-dir] [external-asset-store]
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
const approved = [
  {
    source: "Idle Chatting.vrma",
    file: "chatting.vrma",
    sha256: "d485a7dabb21d4b8809433a23ddf68a43ba5a31761d7106925c6bd8917e56e0d",
  },
  {
    source: "Idle Chatting 2.vrma",
    file: "chatting-2.vrma",
    sha256: "b0c1a26c46e24e03b9fef3b5c61977fea814921f2293527cb3f0706ed39fd4d2",
  },
];
// Validate every input before writing any destination.
const files = await Promise.all(
  approved.map(async (entry) => {
    const bytes = await readFile(path.join(prepared, entry.source));
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new Error(`Unreviewed recording: ${entry.source}`);
    return { ...entry, bytes };
  }),
);
const destination = path.join(store, "animations", "recorded-speech");
await mkdir(destination, { recursive: true });
for (const entry of files) await writeFile(path.join(destination, entry.file), entry.bytes);
await writeFile(
  path.join(destination, "manifest.json"),
  `${JSON.stringify({ schemaVersion: 1, source: "Rokoko everyday idle originals; source-faithful 30 Hz conversion", recordings: approved }, null, 2)}\n`,
);
console.log(`Installed ${files.length} reviewed recordings at ${destination}`);

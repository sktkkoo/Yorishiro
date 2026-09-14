#!/usr/bin/env node
/** Install the finite, reviewed survey without replacing the source original. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = path.resolve(
  process.argv[2] ?? process.env.YORISHIRO_ASSETS_DIR ?? path.join(root, "..", "Yorishiro-assets"),
);
const review = JSON.parse(
  await readFile(path.join(root, "docs/decisions/idle-survey-metrics.json"), "utf8"),
);
const bytes = await readFile(path.join(root, review.output.file));
if (createHash("sha256").update(bytes).digest("hex") !== review.output.sha256)
  throw new Error("Survey differs from the reviewed recording");
const directory = path.join(store, "animations/recorded-idle");
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, "survey.vrma"), bytes);
console.log(`Installed reviewed finite survey at ${directory}`);

#!/usr/bin/env node
/** Rebuild the documented original recordings without losing hips, fingers or source timing.
 * Binaries remain private review artifacts until target/acting/transition review.
 * node scripts/prepare-recorded-library.mjs [source-directory] [report-json]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRecordedFbx } from "./prepare-recorded-fbx.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.resolve(
  process.argv[2] ?? path.join(root, ".motion-review/source-assets/rokoko-everyday-original"),
);
const reportPath = path.resolve(
  process.argv[3] ?? path.join(root, "docs/decisions/source-faithful-library-metrics.json"),
);
if (path.extname(reportPath) !== ".json") throw new Error("Report output must be JSON");
const provenance = JSON.parse(
  await fs.readFile(
    path.join(root, "docs/decisions/recorded-motion-source-provenance.json"),
    "utf8",
  ),
);
const recordings = [];
for (const entry of provenance.files) {
  if (path.basename(entry.file) !== entry.file || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
    throw new Error("Invalid recording provenance entry");
  }
  const outputName = path.basename(entry.existingConvertedVrmA);
  if (outputName !== entry.existingConvertedVrmA || path.extname(outputName) !== ".vrma") {
    throw new Error("Invalid recording output name");
  }
  const animationName =
    outputName === "Idle Conversation.vrma"
      ? "Rokoko Conversation source-faithful"
      : `Rokoko ${path.basename(outputName, ".vrma")} source-faithful`;
  const report = await prepareRecordedFbx({
    inputFbx: path.join(sourceDir, entry.file),
    outputVrma: path.join(root, ".motion-review/source-assets/prepared", outputName),
    expectedSourceSha256: entry.sha256,
    inPointSec: 0.1,
    animationName,
  });
  recordings.push(report);
  console.log(`${outputName}: ${report.preparation.frameCount} source-faithful frames`);
}
await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(
  reportPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      provenance: "recorded-motion-source-provenance.json",
      status:
        "Source-fidelity validated; target acting, contacts and automatic admission require review",
      recordings,
    },
    null,
    2,
  )}\n`,
);
console.log(`Validated ${recordings.length} recordings; report: ${reportPath}`);

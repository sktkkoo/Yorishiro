#!/usr/bin/env node
/** Reproduce the seven user-provided Mixamo conversions; binaries remain private.
 * node scripts/prepare-mixamo-import.mjs [source-directory] [report-json]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRecordedFbx } from "./prepare-recorded-fbx.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.resolve(process.argv[2] ?? path.join(root, "../Yorishiro-assets/sources"));
const outputDir = path.join(root, ".motion-review/mixamo-import-20260915");
const reportPath = path.resolve(
  process.argv[3] ?? path.join(root, "docs/decisions/mixamo-source-conversion.json"),
);
if (path.extname(reportPath) !== ".json") throw new Error("Report output must be JSON");

const sources = [
  ["Sad Idle", "f2aeb3d91d83113363efef245776ec2ff53992d0ac16b41dd620a703e1c07c23"],
  ["Fist Pump", "20679c51027d9c2215edaca1681cd53ac55c6fb2cfc3119ebefd4a8d27b87e5f"],
  ["Thoughtful Head Shake", "28474981675659a419d67b7b4c9026328cdb630f6901183d2474219900cd28c7"],
  ["Shrugging", "8c2f00a6c67ec135f1a5cc98f8ca55c5b28dd5f629b5407be7a370ee9f0e170e"],
  ["Hands Forward Gesture", "730fdc5741dc9bca58b4189a3d273e6fe661c9bd2c7fd514af78c16642c9838b"],
  ["Texting While Standing", "f2aa04ed79ea929344b5344bf1dfc84f792b0abb66d28c9eb275ecceead4ebb2"],
  ["Warrior Idle", "fc918df6793089bb301ef414a87159cb366a18f8f741abae7c8fee7a68c01996"],
];
const recordings = [];
for (const [name, expectedSourceSha256] of sources) {
  const report = await prepareRecordedFbx({
    inputFbx: path.join(sourceDir, `${name}.fbx`),
    outputVrma: path.join(outputDir, `${name}.vrma`),
    expectedSourceSha256,
    inPointSec: 0,
    sampleHz: 30,
    sourceProfile: "mixamo",
    animationName: `Mixamo ${name} source-faithful`,
  });
  await fs.writeFile(
    path.join(outputDir, `${name}.report.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  recordings.push(report);
  console.log(
    `${name}.vrma: ${report.preparation.frameCount} original keys, ${report.outputSha256}`,
  );
}
await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(
  reportPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      source: "Seven user-provided Adobe Mixamo FBX files received 2026-09-15",
      sourceDirectory: path.relative(root, sourceDir),
      outputDirectory: ".motion-review/mixamo-import-20260915",
      status:
        "Source fidelity validated; target acting, context and automatic admission remain separate reviews",
      command: "node scripts/prepare-mixamo-import.mjs",
      recordings,
    },
    null,
    2,
  )}\n`,
);

#!/usr/bin/env node
/** Read-only, actual Yori/AnimationPlayer check for the reviewed quiet Idle.
 * node scripts/measure-quiet-idle-calibration.mjs [report.json]
 * No renderer, network, asset writes or inferred contact windows are used.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VRMHumanBoneName } from "@pixiv/three-vrm";
import { createVRMAnimationClip } from "@pixiv/three-vrm-animation";
import { build } from "esbuild";
import * as THREE from "three";
import { createRig, loadAnimation } from "./measure-conversation-retarget.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".motion-review");
await fs.mkdir(scratch, { recursive: true });
const runtime = path.join(scratch, "quiet-idle-metric-runtime.mjs");
await build({
  stdin: {
    contents:
      'export { AnimationPlayer } from "./src/core/body/animation-player.ts"; export { applyVrmRestPose } from "./src/core/body/vrm-rest-pose.ts"; export { calibrateQuietIdleUpperBodyClip } from "./src/core/body/standing-idle-grounding.ts";',
    resolveDir: root,
  },
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  outfile: runtime,
  logLevel: "silent",
});
const { AnimationPlayer, applyVrmRestPose, calibrateQuietIdleUpperBodyClip } = await import(
  runtime
);
const model = await fs.readFile(path.join(root, "public/models/Yori.vrm"));
const recording = await fs.readFile(path.join(root, "public/animations/Idle.vrma"));
const hash = (data) => createHash("sha256").update(data).digest("hex");
const warnings = [];
const warn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));
const source = await loadAnimation(recording);
const lower = new Set([
  "hips",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "leftToes",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
  "rightToes",
]);
const sampleHz = 60;
const radToDeg = 180 / Math.PI;
const summary = (values) => ({ min: Math.min(...values), max: Math.max(...values) });
const cases = [];
for (const gain of [0.2, 0.5, 0.9, 1]) {
  for (const mode of ["before", "calibrated"]) {
    const rig = await createRig(model, true);
    applyVrmRestPose(rig);
    const player = new AnimationPlayer(rig);
    // Both names refer to exactly the same original bytes. Only anim:Idle's
    // reviewed upper-body loop invokes calibration; the other is the control.
    player.sourceAnimations.set("anim:Idle", source);
    player.sourceAnimations.set("anim:UncalibratedIdleControl", source);
    await player.play("anim:Idle", {
      layer: "foundation",
      mask: "lower-body",
      loop: true,
      weight: 1,
      speed: 0.9,
      fadeInMs: 0,
    });
    await player.play(mode === "before" ? "anim:UncalibratedIdleControl" : "anim:Idle", {
      mask: "upper-body",
      loop: true,
      weight: gain,
      speed: 1,
      fadeInMs: 0,
    });
    const shoulder = [],
      head = [],
      frames = [];
    const footInitial = [],
      maxFootDriftMm = [0, 0, 0, 0];
    const contactNames = ["leftFoot", "leftToes", "rightFoot", "rightToes"];
    const lp = new THREE.Vector3(),
      rp = new THREE.Vector3(),
      hp = new THREE.Quaternion();
    for (let frame = 0; frame < Math.ceil(source.duration * sampleHz); frame++) {
      player.update(frame === 0 ? 0 : 1 / sampleHz);
      rig.humanoid.update();
      rig.scene.updateMatrixWorld(true);
      rig.humanoid.getNormalizedBoneNode("leftUpperArm").getWorldPosition(lp);
      rig.humanoid.getNormalizedBoneNode("rightUpperArm").getWorldPosition(rp);
      const shoulderRoll = Math.atan2(lp.y - rp.y, Math.hypot(lp.x - rp.x, lp.z - rp.z)) * radToDeg;
      rig.humanoid.getNormalizedBoneNode("head").getWorldQuaternion(hp);
      const headUp = new THREE.Vector3(0, 1, 0).applyQuaternion(hp);
      const headRoll = Math.atan2(headUp.x, headUp.y) * radToDeg;
      shoulder.push(shoulderRoll);
      head.push(headRoll);
      if (frame % 120 === 0)
        frames.push({
          sourcePhaseSec: frame / sampleHz,
          shoulderRollDeg: shoulderRoll,
          headUpRollDeg: headRoll,
        });
      for (let index = 0; index < contactNames.length; index++) {
        const position = rig.humanoid
          .getNormalizedBoneNode(contactNames[index])
          .getWorldPosition(lp);
        if (!frame) footInitial[index] = position.clone();
        maxFootDriftMm[index] = Math.max(
          maxFootDriftMm[index],
          position.distanceTo(footInitial[index]) * 1000,
        );
      }
    }
    cases.push({
      mode,
      upperWeight: gain,
      frames: shoulder.length,
      shoulderRollDeg: summary(shoulder),
      headUpRollDeg: summary(head),
      maxFootDriftMm,
      keyframes: frames,
    });
    player.stopAll();
  }
}

// Verify each local rotation delta on the raw retargeted samples before the
// existing loop conditioner changes the short ending window.
const rig = await createRig(model, true);
applyVrmRestPose(rig);
const rest = new Map();
for (const name of Object.values(VRMHumanBoneName)) {
  if (lower.has(name)) continue;
  const bone = rig.humanoid.getNormalizedBoneNode(name);
  if (bone) rest.set(`${bone.name}.quaternion`, bone.quaternion.toArray());
}
// Position-free copy avoids the legacy zero-height source's invalid translation.
const sourceWithoutPositions = Object.assign(Object.create(Object.getPrototypeOf(source)), source, {
  humanoidTracks: { ...source.humanoidTracks, translation: new Map() },
});
const raw = createVRMAnimationClip(sourceWithoutPositions, rig);
const upper = new THREE.AnimationClip(
  "upper",
  raw.duration,
  raw.tracks.filter((track) => rest.has(track.name)),
);
const rawValues = upper.tracks.map((track) => [...track.values]);
const calibrated = calibrateQuietIdleUpperBodyClip(upper, rest);
if (calibrated === upper) throw new Error("Real Yori quiet Idle calibration failed closed");
let samples = 0,
  maxDeltaErrorRad = 0,
  maxSourceExcursionRad = 0;
for (let index = 0; index < upper.tracks.length; index++) {
  const before = upper.tracks[index],
    after = calibrated.tracks[index];
  const q0 = new THREE.Quaternion().fromArray(before.values).normalize();
  const restQ = new THREE.Quaternion().fromArray(rest.get(before.name)).normalize();
  for (let key = 0; key < before.values.length; key += 4) {
    const sourceQ = new THREE.Quaternion().fromArray(before.values, key).normalize();
    maxSourceExcursionRad = Math.max(maxSourceExcursionRad, q0.angleTo(sourceQ));
    const delta = q0.clone().invert().multiply(sourceQ);
    const targetDelta = restQ
      .clone()
      .invert()
      .multiply(new THREE.Quaternion().fromArray(after.values, key).normalize());
    maxDeltaErrorRad = Math.max(maxDeltaErrorRad, delta.angleTo(targetDelta));
    samples++;
  }
}
if (JSON.stringify(rawValues) !== JSON.stringify(upper.tracks.map((track) => [...track.values])))
  throw new Error("Source clip mutated");
for (const result of cases.filter((value) => value.mode === "calibrated")) {
  if (
    Math.max(...Object.values(result.shoulderRollDeg).map(Math.abs)) > 1 ||
    Math.max(...Object.values(result.headUpRollDeg).map(Math.abs)) > 1
  )
    throw new Error("Unexpected quiet Idle shoulder/head tilt");
}
if (maxDeltaErrorRad > 1e-6) throw new Error("Recorded local rotation changes were not preserved");
console.warn = warn;
const report = {
  purpose:
    "Isolate the static upper-body counter-lean in the reviewed quiet Idle. This does not identify the user's exact observed clip or establish superiority over Animates.",
  input: {
    model: "public/models/Yori.vrm",
    modelSha256: hash(model),
    source: "public/animations/Idle.vrma",
    sourceSha256: hash(recording),
    durationSec: source.duration,
  },
  methodology: {
    sampleHz,
    units: "source phase seconds; roll degrees; foot drift millimetres",
    shoulderDefinition:
      "Angle of left/right upper-arm joint centers; positive means anatomical right shoulder lower. Head roll uses the world-space head up vector.",
    playback:
      "Actual AnimationPlayer, upper-body loop at source speed 1; same lower-body foundation at speed 0.9, weight 1. No procedural additions. Existing loop conditioning remains active in both lanes.",
    limitations:
      "This is a quiet-pose correction, not recovery of missing source hips motion, general asymmetry removal, foot contact inference, or validation of other full-body performances. Explicit full-body and other clip variants are unchanged.",
  },
  localMotion: {
    quaternionTracks: upper.tracks.length,
    quaternionSamples: samples,
    maxSourceExcursionRad,
    maxDeltaErrorRad,
    sourceClipUnchanged: true,
  },
  cases,
  warnings: [...new Set(warnings)],
};
const output = path.resolve(
  process.argv[2] ?? path.join(root, "docs/decisions/quiet-idle-calibration-metrics.json"),
);
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      output,
      localMotion: report.localMotion,
      automaticGain: cases.filter((value) => value.upperWeight === 0.9),
    },
    null,
    2,
  ),
);

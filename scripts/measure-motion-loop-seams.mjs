#!/usr/bin/env node
/**
 * Measure the raw and conditioned loop boundary on local VRMA humanoid rotations.
 * Usage: node scripts/measure-motion-loop-seams.mjs [animation-directory] [output-json]
 * No retargeting, root translation, world-space foot contact, or visual rating is measured.
 * esbuild is supplied by the project's Vite development toolchain.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { VRMAnimationLoaderPlugin } from "@pixiv/three-vrm-animation";
import { build } from "esbuild";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const animationDirectory = path.resolve(
  process.argv[2] ?? path.join(projectRoot, "public/animations"),
);
const outputPath = path.resolve(
  process.argv[3] ?? path.join(projectRoot, "docs/decisions/motion-loop-seam-metrics.json"),
);
const sampleHz = 120;
const dt = 1 / sampleHz;
const names = [
  "Idle",
  "Idle Looking Around",
  "Idle Looking Around 2",
  "Idle Watching Something",
  "Idle Conversation",
  "Idle Chatting",
];
const temporaryDirectory = await fs.mkdtemp(path.join(tmpdir(), "yorishiro-loop-metrics-"));

function percentile95(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * 0.95)];
}

function sample(interpolant, time) {
  return new THREE.Quaternion().fromArray(interpolant.evaluate(time)).normalize();
}

function angularVelocity(a, b) {
  const rotation = a.clone().invert().multiply(b).normalize();
  if (rotation.w < 0) rotation.set(-rotation.x, -rotation.y, -rotation.z, -rotation.w);
  const sinHalf = Math.hypot(rotation.x, rotation.y, rotation.z);
  const factor = sinHalf > 1e-8 ? (2 * Math.atan2(sinHalf, rotation.w)) / (sinHalf * dt) : 0;
  return new THREE.Vector3(rotation.x * factor, rotation.y * factor, rotation.z * factor);
}

function measure(clip) {
  const displacement = [];
  const velocityMismatch = [];
  for (const track of clip.tracks) {
    const interpolant = track.createInterpolant();
    const first = sample(interpolant, 0);
    const after = sample(interpolant, dt);
    const last = sample(interpolant, clip.duration);
    const before = sample(interpolant, clip.duration - dt);
    displacement.push(first.angleTo(last));
    velocityMismatch.push(angularVelocity(before, last).distanceTo(angularVelocity(first, after)));
  }
  return {
    poseDisplacementP95Rad: percentile95(displacement),
    angularVelocityMismatchP95RadPerSec: percentile95(velocityMismatch),
  };
}

try {
  const modulePath = path.join(temporaryDirectory, "motion-transition.mjs");
  await build({
    entryPoints: [path.join(projectRoot, "src/core/body/motion-transition.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: modulePath,
    logLevel: "silent",
  });
  const { conditionMotionLoop } = await import(pathToFileURL(modulePath).href);
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  const clips = [];
  for (const name of names) {
    const buffer = await fs.readFile(path.join(animationDirectory, `${name}.vrma`));
    const gltf = await loader.parseAsync(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      "",
    );
    const animation = gltf.userData.vrmAnimations[0];
    // Fingers would otherwise dominate the per-bone percentile despite moving little.
    const tracks = [...animation.humanoidTracks.rotation.entries()]
      .filter(([bone]) => !/Thumb|Index|Middle|Ring|Little/.test(bone))
      .map(([, track]) => track);
    const original = new THREE.AnimationClip(name, animation.duration, tracks);
    const conditioned = conditionMotionLoop(original);
    clips.push({
      name,
      sourceSha256: createHash("sha256").update(buffer).digest("hex"),
      durationSec: original.duration,
      measuredBoneCount: tracks.length,
      sourceFrameCount: Math.max(0, ...tracks.map((track) => track.times.length)),
      sourceQuaternionKeyCount: tracks.reduce((sum, track) => sum + track.times.length, 0),
      conditionedQuaternionKeyCount: conditioned.tracks.reduce(
        (sum, track) => sum + track.times.length,
        0,
      ),
      original: measure(original),
      conditioned: measure(conditioned),
    });
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    method: {
      coordinateSpace: "source humanoid local rotations; before VRM retargeting",
      bones: "all source humanoid rotation tracks except fingers",
      sampleHz,
      velocityDifferenceIntervalSec: dt,
      poseMetric: "p95 across bones of shortest quaternion angle from duration to time zero",
      velocityMetric:
        "p95 across bones of local angular-velocity vector difference at duration and time zero",
      units: { pose: "radians", angularVelocity: "radians per second", duration: "seconds" },
      sourceFrameCount: "maximum authored quaternion key count among measured bones",
      limitations: [
        "Boundary kinematics only; this does not measure perceived naturalness or presence.",
        "Source rotations before retargeting; root translation and world-space feet are not evaluated.",
        "This measures improvement over the same raw VRMA clips, not a comparison with Animates.",
      ],
    },
    clips,
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Measured ${clips.length} clips at ${sampleHz} Hz; wrote ${outputPath}`);
} finally {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}

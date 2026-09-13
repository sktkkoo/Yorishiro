#!/usr/bin/env node
/** Target-world standing Idle contact audit using the actual Three AnimationMixer.
 * Usage: node scripts/measure-standing-idle-grounding.mjs [asset-root] [output-json]
 * No renderer, private screenshots, asset mutation, or guessed source units.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { VRMHumanoid } from "@pixiv/three-vrm";
import { createVRMAnimationClip, VRMAnimationLoaderPlugin } from "@pixiv/three-vrm-animation";
import { build } from "esbuild";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = path.resolve(process.argv[2] ?? path.join(projectRoot, "../Yorishiro-assets"));
const output = path.resolve(
  process.argv[3] ?? path.join(projectRoot, "docs/decisions/standing-idle-grounding-metrics.json"),
);
const footNames = ["leftFoot", "leftToes", "rightFoot", "rightToes"];
const lowerNames = [
  "hips",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "leftToes",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
  "rightToes",
];
const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
const rounded = (value) => Math.round(value * 1e7) / 1e7;
const percentile95 = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * 0.95)];
function glbJson(buffer) {
  if (buffer.readUInt32LE(0) !== 0x46546c67 || buffer.readUInt32LE(4) !== 2)
    throw new Error("Expected GLB 2");
  for (let offset = 12; offset < buffer.length; ) {
    const length = buffer.readUInt32LE(offset);
    if (buffer.readUInt32LE(offset + 4) === 0x4e4f534a)
      return JSON.parse(buffer.subarray(offset + 8, offset + 8 + length).toString("utf8"));
    offset += length + 8;
  }
  throw new Error("GLB has no JSON chunk");
}
function createTarget(json) {
  const scene = new THREE.Object3D();
  const objects = json.nodes.map((node, index) => {
    const object = new THREE.Object3D();
    object.name = node.name ?? `node-${index}`;
    if (node.matrix)
      new THREE.Matrix4()
        .fromArray(node.matrix)
        .decompose(object.position, object.quaternion, object.scale);
    else {
      if (node.translation) object.position.fromArray(node.translation);
      if (node.rotation) object.quaternion.fromArray(node.rotation).normalize();
      if (node.scale) object.scale.fromArray(node.scale);
    }
    return object;
  });
  json.nodes.forEach((node, index) => {
    node.children?.forEach((child) => {
      objects[index].add(objects[child]);
    });
  });
  for (const root of json.scenes[json.scene ?? 0].nodes) scene.add(objects[root]);
  scene.updateMatrixWorld(true);
  const legacy = json.extensions.VRM;
  const definitions = legacy
    ? legacy.humanoid.humanBones.map(({ bone, node }) => {
        const name = bone
          .replace(/ThumbProximal$/, "ThumbMetacarpal")
          .replace(/ThumbIntermediate$/, "ThumbProximal");
        return [name, { node: objects[node] }];
      })
    : Object.entries(json.extensions.VRMC_vrm.humanoid.humanBones).map(([name, { node }]) => [
        name,
        { node: objects[node] },
      ]);
  const humanoid = new VRMHumanoid(Object.fromEntries(definitions));
  scene.add(humanoid.normalizedHumanBonesRoot);
  scene.updateMatrixWorld(true);
  return { scene, humanoid, metaVersion: legacy ? "0" : "1" };
}

const modelBuffer = await fs.readFile(path.join(assetRoot, "models/Yori.vrm"));
const animationBuffer = await fs.readFile(path.join(assetRoot, "animations/Idle.vrma"));
const modelJson = glbJson(modelBuffer);
const loader = new GLTFLoader();
loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
const gltf = await loader.parseAsync(
  animationBuffer.buffer.slice(
    animationBuffer.byteOffset,
    animationBuffer.byteOffset + animationBuffer.length,
  ),
  "",
);
const animation = gltf.userData.vrmAnimations[0];
const temporaryDirectory = await fs.mkdtemp(path.join(tmpdir(), "yorishiro-standing-idle-"));
try {
  const modulePath = path.join(temporaryDirectory, "prepare.mjs");
  await build({
    stdin: {
      contents:
        'export * from "./src/core/body/standing-idle-grounding.ts"; export { conditionMotionLoop } from "./src/core/body/motion-transition.ts";',
      resolveDir: projectRoot,
    },
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: modulePath,
    logLevel: "silent",
  });
  const { calibrateStandingIdleClip, groundStandingIdleClip, conditionMotionLoop } = await import(
    pathToFileURL(modulePath).href
  );
  const scenarios = [
    0,
    0.2,
    0.5,
    1,
    "fade-in-1.2s",
    "fade-out-1.2s",
    "gain-1-to-0.2",
    "fade-in-phase-2.1s",
    "fade-out-phase-2.1s",
    "gain-phase-2.1s",
  ];
  const variants = [
    "stripped-absolute",
    "grounded-absolute",
    "calibrated",
    "calibrated-conditioned-grounded",
  ];
  const rows = [];
  let maxRecordedDeltaRadians = 0;
  for (const variant of variants)
    for (const scenario of scenarios) {
      const target = createTarget(modelJson);
      const vrm = { ...target, meta: { metaVersion: target.metaVersion } };
      const names = new Set(
        lowerNames.map((name) => `${target.humanoid.getNormalizedBoneNode(name).name}.quaternion`),
      );
      const original = createVRMAnimationClip(animation, vrm);
      original.tracks = original.tracks.filter((track) => names.has(track.name));
      let clip = original;
      if (variant.includes("calibrated")) clip = calibrateStandingIdleClip(clip, vrm);
      if (variant.includes("conditioned")) clip = conditionMotionLoop(clip);
      const preGround = clip;
      if (variant.includes("grounded")) clip = groundStandingIdleClip(clip, vrm);
      if (variant.includes("grounded") && clip === preGround)
        throw new Error(`grounding rejected ${variant}`);
      for (const track of original.tracks) {
        const first = new THREE.Quaternion().fromArray(track.values).normalize();
        for (let k = 0; k < track.values.length; k += 4)
          maxRecordedDeltaRadians = Math.max(
            maxRecordedDeltaRadians,
            first.angleTo(new THREE.Quaternion().fromArray(track.values, k).normalize()),
          );
      }
      const mixer = new THREE.AnimationMixer(target.scene);
      const action = mixer.clipAction(clip).setLoop(THREE.LoopRepeat, Infinity).play();
      const steps = Math.ceil(clip.duration * 120);
      const dt = clip.duration / steps;
      const first = [];
      let prior = [];
      const speeds = [];
      let maxDrift = 0,
        maxRawDrift = 0,
        maxRigDifference = 0,
        maxHipDelta = 0;
      const rawFirst = [];
      const restHips = target.humanoid.getNormalizedBoneNode("hips").position.clone();
      for (let frame = 0; frame <= steps * 2; frame++) {
        const time = frame * dt;
        const u = Math.max(0, Math.min(1, time / 1.2));
        const fade = u * u * (3 - 2 * u);
        const weight =
          typeof scenario === "number"
            ? scenario
            : scenario.startsWith("fade-in")
              ? fade
              : scenario.startsWith("fade-out")
                ? 1 - fade
                : 1 - 0.8 * fade;
        action.setEffectiveWeight(weight);
        mixer.setTime(
          time + (typeof scenario === "string" && scenario.includes("phase") ? 2.1 : 0),
        );
        target.scene.updateMatrixWorld(true);
        target.humanoid.update();
        target.scene.updateMatrixWorld(true);
        const positions = footNames.map((name) =>
          target.humanoid.getNormalizedBoneNode(name).getWorldPosition(new THREE.Vector3()),
        );
        const rawPositions = footNames.map((name) =>
          target.humanoid.getRawBoneNode(name).getWorldPosition(new THREE.Vector3()),
        );
        if (frame === 0) {
          first.push(...positions.map((p) => p.clone()));
          rawFirst.push(...rawPositions.map((p) => p.clone()));
        }
        for (let foot = 0; foot < positions.length; foot++) {
          maxDrift = Math.max(maxDrift, positions[foot].distanceTo(first[foot]));
          maxRawDrift = Math.max(maxRawDrift, rawPositions[foot].distanceTo(rawFirst[foot]));
          maxRigDifference = Math.max(
            maxRigDifference,
            positions[foot].distanceTo(rawPositions[foot]),
          );
          if (frame > 0) speeds.push(positions[foot].distanceTo(prior[foot]) / dt);
        }
        prior = positions;
        maxHipDelta = Math.max(
          maxHipDelta,
          target.humanoid.getNormalizedBoneNode("hips").position.distanceTo(restHips),
        );
      }
      rows.push({
        variant,
        scenario,
        maxFootDriftMm: rounded(maxDrift * 1000),
        footSpeedP95MmPerSec: rounded(percentile95(speeds) * 1000),
        maxFootSpeedMmPerSec: rounded(Math.max(...speeds) * 1000),
        maxHipTranslationMm: rounded(maxHipDelta * 1000),
        maxRawFootDriftMm: rounded(maxRawDrift * 1000),
        maxRawNormalizedDifferenceMm: rounded(maxRigDifference * 1000),
      });
      mixer.stopAllAction();
    }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      file: "Idle.vrma",
      sha256: hash(animationBuffer),
      sourceRestHipsHeight: animation.restHipsPosition.y,
      durationSec: animation.duration,
      maxRecordedLowerRotationDeltaDegrees: rounded((maxRecordedDeltaRadians * 180) / Math.PI),
    },
    target: { file: "Yori.vrm", sha256: hash(modelBuffer) },
    method: {
      sampleHz: 120,
      duration: "two complete loops",
      feet: footNames,
      space: "target-world normalized and SDK-updated raw humanoid FK",
      driftReference: "first frame of each weight/scenario, after mixer application",
      fade: "actual AnimationMixer effective weights with 1.2-second smoothstep, progressing clip time",
      procedure:
        "lower-body recorded rotation deltas relative to frame 0 and target normalized rest, loop condition, then common four-contact hips translation sampled at 60 Hz",
      limitations: [
        "Only reviewed quiet Idle; no contact inference, IK, floor collision, mesh skinning, or perceptual evaluation.",
        "Static model transforms and no procedural layers; live head/body layers require visual validation.",
        "Gain/fade measurements start at phases 0 and 2.1 seconds; transitions from arbitrary full-body leg stances are not guaranteed contact-preserving.",
        "Source translation is not used: the converter source has zero rest hip height.",
      ],
    },
    results: rows,
  };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}

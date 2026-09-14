#!/usr/bin/env node
// Read-only VRMA analysis on the target VRM's normalized humanoid skeleton.
// Usage: node scripts/analyze-motion-assets.mjs [asset-root] [output-json]
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VRMHumanoid } from "@pixiv/three-vrm";
import { createVRMAnimationClip, VRMAnimationLoaderPlugin } from "@pixiv/three-vrm-animation";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = path.resolve(process.argv[2] ?? path.join(projectRoot, "../Yorishiro-assets"));
const outputPath = path.resolve(
  process.argv[3] ?? path.join(projectRoot, "docs/decisions/motion-assets-analysis.json"),
);
const SAMPLE_HZ = 60;
const BONES = [
  "hips",
  "spine",
  "chest",
  "upperChest",
  "neck",
  "head",
  "leftShoulder",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  "rightShoulder",
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "leftToes",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
  "rightToes",
];
const FOOT_BONES = ["leftToes", "rightToes"];
const IDLE_NAMES = [
  "Idle",
  "Idle Looking Around",
  "Idle Looking Around 2",
  "Idle Watching Something",
  "VRMA_06_HandOnHip",
];
const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
const round = (value) => (Number.isFinite(value) ? Math.round(value * 100_000) / 100_000 : null);
const mean = (values) => values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);
const rms = (values) => Math.sqrt(mean(values.map((v) => v * v)));
function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}
function stats(values) {
  return {
    mean: round(mean(values)),
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    max: round(Math.max(0, ...values)),
  };
}
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
function sampleMotion(animation, target) {
  const steps = Math.max(1, Math.ceil(animation.duration * SAMPLE_HZ));
  const dt = animation.duration / steps;
  const channels = [...animation.humanoidTracks.rotation]
    .map(([name, track]) => ({
      name,
      node: target.humanoid.getNormalizedBoneNode(name),
      interpolant: track.createInterpolant(),
    }))
    .filter((channel) => channel.node);
  const translationTrack = animation.humanoidTracks.translation.get("hips");
  const translation = translationTrack?.createInterpolant();
  const sourceFirst = translation
    ? new THREE.Vector3().fromArray(translation.evaluate(0))
    : new THREE.Vector3();
  const restHips = new THREE.Vector3().fromArray(target.humanoid.normalizedRestPose.hips.position);
  const hipScale =
    animation.restHipsPosition.y > 0.001 ? restHips.y / animation.restHipsPosition.y : null;
  const frames = [];
  target.humanoid.resetNormalizedPose();
  target.scene.updateMatrixWorld(true);
  const restToes = FOOT_BONES.map((name) =>
    target.humanoid.getNormalizedBoneNode(name).getWorldPosition(new THREE.Vector3()),
  );
  for (let frame = 0; frame <= steps; frame++) {
    const time = frame * dt;
    for (const { node, interpolant } of channels) {
      node.quaternion.fromArray(interpolant.evaluate(time)).normalize();
      if (target.metaVersion === "0") {
        node.quaternion.x *= -1;
        node.quaternion.z *= -1;
      }
    }
    target.humanoid.getNormalizedBoneNode("hips").position.copy(restHips);
    target.scene.updateMatrixWorld(true);
    const rootDelta = translation
      ? new THREE.Vector3()
          .fromArray(translation.evaluate(time))
          .sub(sourceFirst)
          .multiplyScalar(hipScale ?? 1)
      : new THREE.Vector3();
    if (target.metaVersion === "0") {
      rootDelta.x *= -1;
      rootDelta.z *= -1;
    }
    frames.push({
      time,
      rootDelta,
      rotations: BONES.map(
        (name) =>
          target.humanoid.getNormalizedBoneNode(name)?.quaternion.clone() ?? new THREE.Quaternion(),
      ),
      toes: FOOT_BONES.map((name) =>
        target.humanoid.getNormalizedBoneNode(name).getWorldPosition(new THREE.Vector3()),
      ),
    });
  }
  target.humanoid.resetNormalizedPose();
  return { frames, dt, hipScale, restToes };
}
function analyzeSamples({ frames, dt, restToes }, includeRoot = false) {
  const speeds = BONES.map(() => []);
  const toeSpeeds = [[], []];
  const toePositions = [[], []];
  const bodySpeedRms = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    for (let foot = 0; foot < 2; foot++) {
      const position = frame.toes[foot].clone();
      if (includeRoot) position.add(frame.rootDelta);
      toePositions[foot].push(position);
      if (i > 0) toeSpeeds[foot].push(position.distanceTo(toePositions[foot][i - 1]) / dt);
    }
    if (i === 0) continue;
    const boneSpeeds = frame.rotations.map(
      (q, bone) => THREE.MathUtils.radToDeg(q.angleTo(frames[i - 1].rotations[bone])) / dt,
    );
    boneSpeeds.forEach((speed, bone) => {
      speeds[bone].push(speed);
    });
    bodySpeedRms.push(rms(boneSpeeds));
  }
  const floor = percentile(
    toePositions.flat().map((position) => position.y),
    0.05,
  );
  const feet = Object.fromEntries(
    FOOT_BONES.map((name, foot) => {
      const heights = toePositions[foot].map((p) => p.y);
      const contact = toeSpeeds[foot].map(
        (speed, i) => speed < 0.04 && heights[i + 1] < floor + 0.03,
      );
      const supportTravel = toePositions[foot].map((p) =>
        Math.hypot(p.x - toePositions[foot][0].x, p.z - toePositions[foot][0].z),
      );
      return [
        name,
        {
          speedMetresPerSecond: stats(toeSpeeds[foot]),
          heightRangeMetres: round(Math.max(...heights) - Math.min(...heights)),
          minHeightRelativeToRestMetres: round(Math.min(...heights) - restToes[foot].y),
          maxHorizontalDistanceFromStartMetres: round(Math.max(...supportTravel)),
          inferredContactRatio: round(mean(contact.map(Number))),
        },
      ];
    }),
  );
  const seamAngles = frames[0].rotations.map((q, bone) =>
    THREE.MathUtils.radToDeg(q.angleTo(frames.at(-1).rotations[bone])),
  );
  const rotationMetrics = Object.fromEntries(
    BONES.map((bone, index) => [
      bone,
      {
        speedDegreesPerSecond: stats(speeds[index]),
        maxAngleFromFirstDegrees: round(
          Math.max(
            ...frames.map((f) =>
              THREE.MathUtils.radToDeg(f.rotations[index].angleTo(frames[0].rotations[index])),
            ),
          ),
        ),
      },
    ]),
  );
  const quietWindows = [];
  for (let from = 0; from + 2 <= frames.at(-1).time; from += 0.25) {
    const start = Math.ceil(from / dt);
    const end = Math.min(frames.length - 1, Math.floor((from + 2) / dt));
    const motion = mean(bodySpeedRms.slice(start, end));
    const footSpeed = Math.max(...toeSpeeds.flatMap((values) => values.slice(start, end)));
    const seam = rms(
      frames[start].rotations.map((q, bone) =>
        THREE.MathUtils.radToDeg(q.angleTo(frames[end].rotations[bone])),
      ),
    );
    quietWindows.push({
      startSeconds: round(frames[start].time),
      endSeconds: round(frames[end].time),
      meanBodySpeedRmsDegreesPerSecond: round(motion),
      maxToeSpeedMetresPerSecond: round(footSpeed),
      endpointPoseRmsDegrees: round(seam),
    });
  }
  const selectedWindows = [];
  for (const window of quietWindows.sort(
    (a, b) => a.meanBodySpeedRmsDegreesPerSecond - b.meanBodySpeedRmsDegreesPerSecond,
  )) {
    if (
      selectedWindows.every(
        (other) =>
          window.endSeconds <= other.startSeconds || window.startSeconds >= other.endSeconds,
      )
    )
      selectedWindows.push(window);
    if (selectedWindows.length === 5) break;
  }
  return {
    bodySpeedRmsDegreesPerSecond: stats(bodySpeedRms),
    loopSeam: {
      poseRmsDegrees: round(rms(seamAngles)),
      poseMaxDegrees: round(Math.max(...seamAngles)),
      toeDistancesMetres: toePositions.map((p) => round(p[0].distanceTo(p.at(-1)))),
    },
    feet,
    rotationMetrics,
    quietWindows: selectedWindows,
  };
}

function verifyAgainstOfficialMixer(animation, target, sampled) {
  const clip = createVRMAnimationClip(animation, {
    humanoid: target.humanoid,
    meta: { metaVersion: target.metaVersion },
  });
  clip.tracks = clip.tracks.filter((track) => !track.name.endsWith(".position"));
  const mixer = new THREE.AnimationMixer(target.scene);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  let maxToeError = 0;
  let maxAngleError = 0;
  for (const fraction of [0, 0.13, 0.5, 0.83]) {
    const expected = sampled.frames[Math.floor((sampled.frames.length - 1) * fraction)];
    mixer.setTime(expected.time);
    target.scene.updateMatrixWorld(true);
    for (let bone = 0; bone < BONES.length; bone++) {
      const actual = target.humanoid
        .getNormalizedBoneNode(BONES[bone])
        .quaternion.clone()
        .normalize();
      maxAngleError = Math.max(
        maxAngleError,
        THREE.MathUtils.radToDeg(actual.angleTo(expected.rotations[bone])),
      );
    }
    for (let foot = 0; foot < FOOT_BONES.length; foot++) {
      const actual = target.humanoid
        .getNormalizedBoneNode(FOOT_BONES[foot])
        .getWorldPosition(new THREE.Vector3());
      maxToeError = Math.max(maxToeError, actual.distanceTo(expected.toes[foot]));
    }
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(target.scene);
  target.humanoid.resetNormalizedPose();
  if (maxToeError > 0.0001 || maxAngleError > 0.01)
    throw new Error("Analytical sampling disagrees with official retarget/mixer");
  return {
    samples: 4,
    maxToeErrorMetres: round(maxToeError),
    maxLocalRotationErrorDegrees: round(maxAngleError),
  };
}

const modelBuffer = await fs.readFile(path.join(assetRoot, "models/Yori.vrm"));
const modelJson = glbJson(modelBuffer);
const target = createTarget(modelJson);
const loader = new GLTFLoader();
loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
const files = (await fs.readdir(path.join(assetRoot, "animations")))
  .filter((name) => name.endsWith(".vrma"))
  .sort();
const results = [];
const idleSamples = new Map();
for (const file of files) {
  const buffer = await fs.readFile(path.join(assetRoot, "animations", file));
  const json = glbJson(buffer);
  const gltf = await loader.parseAsync(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    "",
  );
  const animation = gltf.userData.vrmAnimations?.[0];
  if (!animation) throw new Error(`${file}: no humanoid animation`);
  const sampled = sampleMotion(animation, target);
  if (IDLE_NAMES.includes(path.basename(file, ".vrma"))) idleSamples.set(file, sampled);
  const retargetVerification = verifyAgainstOfficialMixer(animation, target, sampled);
  const rotationsOnly = analyzeSamples(sampled);
  const rootDeltas = sampled.frames.map((frame) => frame.rootDelta);
  const hasTranslation = animation.humanoidTracks.translation.has("hips");
  const root = {
    hasTranslation,
    sourceRestHipsHeight: round(animation.restHipsPosition.y),
    calibratedRetargetScale: round(sampled.hipScale),
    translationInterpretation: !hasTranslation
      ? "none"
      : sampled.hipScale === null
        ? "uncalibrated-source-units; source has no valid rest hip height"
        : "metres on target skeleton, relative to first frame",
    maxDistanceFromStart: round(Math.max(...rootDeltas.map((p) => p.length()))),
    xRange: round(
      Math.max(...rootDeltas.map((p) => p.x)) - Math.min(...rootDeltas.map((p) => p.x)),
    ),
    yRange: round(
      Math.max(...rootDeltas.map((p) => p.y)) - Math.min(...rootDeltas.map((p) => p.y)),
    ),
    zRange: round(
      Math.max(...rootDeltas.map((p) => p.z)) - Math.min(...rootDeltas.map((p) => p.z)),
    ),
  };
  results.push({
    file,
    sha256: hash(buffer),
    generator: json.asset.generator ?? null,
    durationSeconds: round(animation.duration),
    retargetVerification,
    sampleCount: sampled.frames.length,
    nativeRotationTrackSampleCounts: [
      ...new Set(
        [...animation.humanoidTracks.rotation.values()].map((track) => track.times.length),
      ),
    ],
    root,
    rotationsOnly,
    withRootDelta:
      hasTranslation && sampled.hipScale !== null ? analyzeSamples(sampled, true) : null,
  });
}
const idleFrames = idleSamples.get("Idle.vrma")?.frames;
const idleWindowConnections = idleFrames
  ? results
      .filter((asset) => asset.file !== "Idle.vrma" && idleSamples.has(asset.file))
      .flatMap((asset) => {
        const sampled = idleSamples.get(asset.file);
        return asset.rotationsOnly.quietWindows.map((window) => {
          const targetFrame = sampled.frames[Math.round(window.startSeconds / sampled.dt)];
          let best = null;
          for (let index = 0; index < idleFrames.length; index += 6) {
            const sourceFrame = idleFrames[index];
            const poseRmsDegrees = rms(
              sourceFrame.rotations.map((q, bone) =>
                THREE.MathUtils.radToDeg(q.angleTo(targetFrame.rotations[bone])),
              ),
            );
            if (best === null || poseRmsDegrees < best.poseRmsDegrees) {
              best = {
                sourceTimeSeconds: sourceFrame.time,
                poseRmsDegrees,
                maxToeDistanceMetres: Math.max(
                  ...sourceFrame.toes.map((toe, foot) => toe.distanceTo(targetFrame.toes[foot])),
                ),
              };
            }
          }
          return {
            targetFile: asset.file,
            targetStartSeconds: window.startSeconds,
            targetEndSeconds: window.endSeconds,
            bestEntryFromIdleByPoseOnly: Object.fromEntries(
              Object.entries(best).map(([key, value]) => [key, round(value)]),
            ),
          };
        });
      })
  : [];
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  targetModel: {
    file: "models/Yori.vrm",
    sha256: hash(modelBuffer),
    metaVersion: target.metaVersion,
    normalizedRestHipHeightMetres: round(target.humanoid.normalizedRestPose.hips.position[1]),
  },
  method: {
    sampleHz: SAMPLE_HZ,
    bones: BONES,
    description:
      "Official three-vrm-animation loader normalizes source rotation tracks. Retargeting uses the target VRMHumanoid normalized skeleton and the official VRM 0 quaternion axis conversion. FK runs without mesh, procedural offsets, blending, or runtime ground correction. Rotations-only mode holds the hips at target rest position, matching the historical stripped-root playback policy. Root-delta mode adds calibrated source translation relative to its first frame; it does not assume original absolute root height is valid.",
    contactHeuristic:
      "Toe speed < 0.04 m/s and height < clip-wide fifth-percentile toe height + 0.03 m. A diagnostic proxy, not ground-truth contact. Toe joint height is not sole penetration. Infer contact separately for each mode; ratios are not independent proof of foot-lock quality.",
    limitations: [
      "No visual QA or Animates measurements",
      "Runtime blending, retargeted mesh, spring bones, toe/sole shape, and procedural offsets can change visible results",
      "Short low-speed windows are not automatically safe transitions",
      "Rotations with no source skeleton are interpreted using the loader's identity-rest convention",
      "Zero source rest hip height makes standard translation scaling invalid; uncalibrated source deltas are reported but never included in metre-based FK",
      "Quiet windows are ranked by motion energy only and require semantic/pose/contact review before use",
    ],
  },
  idleCandidateFiles: IDLE_NAMES.map((name) => `${name}.vrma`),
  idleWindowConnections,
  assets: results,
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `Analyzed ${results.length} assets at ${SAMPLE_HZ} Hz -> ${path.relative(projectRoot, outputPath)}`,
);
console.table(
  results
    .filter((asset) => IDLE_NAMES.includes(path.basename(asset.file, ".vrma")))
    .map((asset) => ({
      clip: asset.file,
      duration: asset.durationSeconds,
      bodySpeedP95: asset.rotationsOnly.bodySpeedRmsDegreesPerSecond.p95,
      toeSpeedP95: Math.max(
        ...Object.values(asset.rotationsOnly.feet).map((foot) => foot.speedMetresPerSecond.p95),
      ),
      toeHeightRange: Math.max(
        ...Object.values(asset.rotationsOnly.feet).map((foot) => foot.heightRangeMetres),
      ),
      seamRms: asset.rotationsOnly.loopSeam.poseRmsDegrees,
      restHip: asset.root.sourceRestHipsHeight,
    })),
);

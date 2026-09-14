#!/usr/bin/env node
/** Offline, source-faithful Conversation preparation. No runtime or asset-store writes.
 * node scripts/prepare-recorded-fbx.mjs [input-fbx] [output-vrma] [report-json]
 * The defaults use the separately downloaded official source and an ignored output.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VRMHumanoid } from "@pixiv/three-vrm";
import { createVRMAnimationClip, VRMAnimationLoaderPlugin } from "@pixiv/three-vrm-animation";
import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultSource = path.join(
  projectRoot,
  ".motion-review/source-assets/rokoko-everyday-original/Idle_Conversation_Loop_MIXAMO_769_segment-2.fbx",
);
const defaultOutput = path.join(
  projectRoot,
  ".motion-review/source-assets/prepared/Idle Conversation.vrma",
);
const defaultReport = path.join(
  projectRoot,
  "docs/decisions/source-faithful-conversation-metrics.json",
);
const expectedConversationSha256 =
  "67892a332df013461020b839c165a04bdc8e20552344d098962e587826dcd556";
const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
const arrayBuffer = (buffer) =>
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
const fingerPattern = /Thumb|Index|Middle|Ring|Little/;
const mapping = {
  Hips: "hips",
  Spine: "spine",
  Spine1: "chest",
  Spine2: "upperChest",
  Neck: "neck",
  Head: "head",
};
for (const side of ["Left", "Right"]) {
  const lower = side.toLowerCase();
  for (const [source, target] of Object.entries({
    Shoulder: "Shoulder",
    Arm: "UpperArm",
    ForeArm: "LowerArm",
    Hand: "Hand",
    UpLeg: "UpperLeg",
    Leg: "LowerLeg",
    Foot: "Foot",
    ToeBase: "Toes",
  }))
    mapping[side + source] = lower + target;
  for (const finger of ["Thumb", "Index", "Middle", "Ring", "Pinky"]) {
    const segments =
      finger === "Thumb"
        ? ["Metacarpal", "Proximal", "Distal"]
        : ["Proximal", "Intermediate", "Distal"];
    segments.forEach((segment, i) => {
      mapping[`${side}Hand${finger}${i + 1}`] =
        lower + (finger === "Pinky" ? "Little" : finger) + segment;
    });
  }
}

function sourceRig(buffer) {
  const scene = new FBXLoader().parse(arrayBuffer(buffer), "");
  const unit = scene.userData.unitScaleFactor;
  if (!(Number.isFinite(unit) && unit > 0)) throw new Error("FBX has no valid UnitScaleFactor");
  const metresPerUnit = unit / 100;
  const bones = new Map();
  scene.traverse((node) => {
    node.position.multiplyScalar(metresPerUnit);
    if (node.scale.distanceTo(new THREE.Vector3(1, 1, 1)) > 1e-6)
      throw new Error(`Unsupported non-unit rest scale: ${node.name}`);
    const name = mapping[node.name.replace(/^mixamorig:?/, "")];
    if (node.isBone && name) bones.set(name, node);
  });
  if (
    bones.size !== 52 ||
    [...bones.keys()].filter((name) => fingerPattern.test(name)).length !== 30
  )
    throw new Error(
      "This preparation requires the reviewed 52-bone Mixamo skeleton including all fingers",
    );
  const clip = scene.animations[0];
  if (!clip || scene.animations.length !== 1) throw new Error("Expected one source animation");
  const staticTranslationOffsets = [];
  for (const track of clip.tracks) {
    if (track.name.endsWith(".position"))
      track.values = Float32Array.from(track.values, (value) => value * metresPerUnit);
    if (!Array.from(track.values).every(Number.isFinite))
      throw new Error(`Non-finite source values: ${track.name}`);
    if (
      track.name.endsWith(".scale") &&
      Array.from(track.values).some((value) => Math.abs(value - 1) > 1e-6)
    )
      throw new Error(`Animated scale is unsupported: ${track.name}`);
    if (track.name.endsWith(".position") && track.name !== `${bones.get("hips").name}.position`) {
      for (let i = 3; i < track.values.length; i++)
        if (Math.abs(track.values[i] - track.values[i % 3]) > 1e-6)
          throw new Error(`Animated non-hips translation is unsupported: ${track.name}`);
      // FBX may animate a constant offset that differs from the declared bind
      // position. VRMA cannot animate non-hips translation, so bake this constant
      // into the reference hierarchy rather than silently dropping centimetres.
      const node = scene.getObjectByName(track.name.slice(0, -".position".length));
      if (!node) throw new Error(`Missing translation node: ${track.name}`);
      const constant = new THREE.Vector3().fromArray(track.values);
      const distance = node.position.distanceTo(constant);
      if (distance > 1e-6)
        staticTranslationOffsets.push({ node: node.name, displacementMetres: distance });
      node.position.copy(constant);
    }
  }
  scene.updateMatrixWorld(true);
  const humanoid = new VRMHumanoid(
    Object.fromEntries([...bones].map(([name, node]) => [name, { node }])),
  );
  scene.add(humanoid.normalizedHumanBonesRoot);
  scene.updateMatrixWorld(true);
  return {
    scene,
    bones,
    clip,
    humanoid,
    unit,
    metresPerUnit,
    staticTranslationOffsets,
    meta: { metaVersion: "1" },
  };
}

function bake(source, inPoint, outPoint, sampleHz, originalTimes) {
  const duration = outPoint - inPoint;
  const sampleCount = originalTimes?.length ?? Math.ceil(duration * sampleHz) + 1;
  if (!(duration > 0 && sampleCount <= 18_001)) throw new Error("Invalid or excessive duration");
  const times = originalTimes
    ? Float32Array.from(originalTimes, (time) => time - inPoint)
    : Float32Array.from({ length: sampleCount }, (_, i) => Math.min(i / sampleHz, duration));
  const rotations = new Map();
  for (const [name, bone] of source.bones) {
    const track = source.clip.tracks.find(
      (candidate) => candidate.name === `${bone.name}.quaternion`,
    );
    if (!track) throw new Error(`Missing rotation: ${name}`);
    const parentRest = bone.parent.getWorldQuaternion(new THREE.Quaternion());
    const inverseRest = bone.getWorldQuaternion(new THREE.Quaternion()).invert();
    const interpolant = track.createInterpolant();
    const q = new THREE.Quaternion(),
      previous = new THREE.Quaternion(),
      values = new Float32Array(sampleCount * 4);
    for (let i = 0; i < times.length; i++) {
      q.fromArray(interpolant.evaluate(inPoint + times[i]))
        .premultiply(parentRest)
        .multiply(inverseRest)
        .normalize();
      if (i > 0 && q.dot(previous) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      q.toArray(values, i * 4);
      previous.copy(q);
    }
    rotations.set(name, values);
  }
  const hips = source.bones.get("hips");
  const position = source.clip.tracks
    .find((track) => track.name === `${hips.name}.position`)
    .createInterpolant();
  const parent = hips.parent.matrixWorld.clone();
  const initial = new THREE.Vector3().fromArray(position.evaluate(inPoint)).applyMatrix4(parent);
  const originOffset = new THREE.Vector3(initial.x, 0, initial.z);
  const positions = new Float32Array(sampleCount * 3),
    p = new THREE.Vector3();
  for (let i = 0; i < times.length; i++)
    p.fromArray(position.evaluate(inPoint + times[i]))
      .applyMatrix4(parent)
      .sub(originOffset)
      .toArray(positions, i * 3);
  return { duration, times, rotations, positions, originOffset };
}

function encodeVrma(source, baked, sourceSha256, animationName) {
  const names = [...source.bones.keys()];
  const nodeIndex = new Map(
    names.map((name, i) => [source.humanoid.getNormalizedBoneNode(name), i]),
  );
  const nodes = names.map((name) => {
    const node = source.humanoid.getNormalizedBoneNode(name);
    const children = node.children.map((child) => nodeIndex.get(child));
    if (children.some((index) => index === undefined)) throw new Error("Unmapped normalized child");
    return { name, translation: node.position.toArray(), ...(children.length ? { children } : {}) };
  });
  const chunks = [],
    accessors = [],
    bufferViews = [];
  let byteLength = 0;
  const accessor = (array, type, min, max) => {
    const buffer = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: buffer.byteLength });
    chunks.push(buffer);
    byteLength += buffer.byteLength;
    const index = accessors.length;
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: 5126,
      count: array.length / { SCALAR: 1, VEC3: 3, VEC4: 4 }[type],
      type,
      ...(min ? { min, max } : {}),
    });
    return index;
  };
  const timeAccessor = accessor(baked.times, "SCALAR", [0], [baked.times[baked.times.length - 1]]);
  const samplers = [],
    channels = [];
  const addChannel = (name, targetPath, values, type) => {
    channels.push({
      sampler: samplers.length,
      target: { node: names.indexOf(name), path: targetPath },
    });
    samplers.push({ input: timeAccessor, output: accessor(values, type), interpolation: "LINEAR" });
  };
  for (const [name, values] of baked.rotations) addChannel(name, "rotation", values, "VEC4");
  addChannel("hips", "translation", baked.positions, "VEC3");
  const json = {
    asset: { version: "2.0", generator: "Yorishiro source-faithful FBX preparation" },
    scene: 0,
    scenes: [{ nodes: [names.indexOf("hips")] }],
    nodes,
    animations: [{ name: animationName, channels, samplers }],
    buffers: [{ byteLength }],
    bufferViews,
    accessors,
    extensionsUsed: ["VRMC_vrm_animation"],
    extensions: {
      VRMC_vrm_animation: {
        specVersion: "1.0",
        humanoid: { humanBones: Object.fromEntries(names.map((name, node) => [name, { node }])) },
      },
    },
    extras: {
      sourceSha256,
      translation: "source hips XYZ; constant initial XZ removed; metres",
      sampleHz: 30,
    },
  };
  const rawJson = Buffer.from(JSON.stringify(json)),
    jsonBytes = Buffer.alloc(Math.ceil(rawJson.length / 4) * 4, 0x20);
  rawJson.copy(jsonBytes);
  const bin = Buffer.concat(chunks),
    header = Buffer.alloc(12),
    jsonHeader = Buffer.alloc(8),
    binHeader = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + jsonBytes.length + bin.length, 8);
  jsonHeader.writeUInt32LE(jsonBytes.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonBytes, binHeader, bin]);
}

async function validateRoundtrip(sourceBuffer, vrmaBuffer, baked, inPoint) {
  const original = sourceRig(sourceBuffer),
    replay = sourceRig(sourceBuffer);
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  const gltf = await loader.parseAsync(arrayBuffer(vrmaBuffer), "");
  const animation = gltf.userData.vrmAnimations[0];
  if (
    !(animation.restHipsPosition.y > 0) ||
    animation.humanoidTracks.rotation.size !== 52 ||
    animation.humanoidTracks.translation.size !== 1
  )
    throw new Error("Invalid VRMA root/rotation channels");
  const clip = createVRMAnimationClip(animation, replay);
  if (!clip.tracks.every((track) => Array.from(track.values).every(Number.isFinite)))
    throw new Error("Non-finite official retarget result");
  const originalMixer = new THREE.AnimationMixer(original.scene),
    replayMixer = new THREE.AnimationMixer(replay.scene);
  const actions = [];
  for (const [mixer, actionClip] of [
    [originalMixer, original.clip],
    [replayMixer, clip],
  ]) {
    const action = mixer.clipAction(actionClip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    actions.push(action);
  }
  const measure = (times) => {
    // The previous sweep may have clamped a LoopOnce action at its last frame.
    for (const action of actions) action.reset().play();
    let maxPosition = 0,
      maxAngle = 0,
      maxHips = 0;
    const feet = Object.fromEntries(
      ["leftFoot", "leftToes", "rightFoot", "rightToes"].map((name) => [name, 0]),
    );
    const p = new THREE.Vector3(),
      q = new THREE.Vector3(),
      a = new THREE.Quaternion(),
      b = new THREE.Quaternion();
    for (const time of times) {
      originalMixer.setTime(inPoint + time);
      original.scene.updateMatrixWorld(true);
      replayMixer.setTime(time);
      replay.humanoid.update();
      replay.scene.updateMatrixWorld(true);
      for (const [name, bone] of original.bones) {
        bone.getWorldPosition(p).sub(baked.originOffset);
        replay.bones.get(name).getWorldPosition(q);
        const error = p.distanceTo(q);
        maxPosition = Math.max(maxPosition, error);
        if (name === "hips") maxHips = Math.max(maxHips, error);
        if (name in feet) feet[name] = Math.max(feet[name], error);
        bone.getWorldQuaternion(a).normalize();
        replay.bones.get(name).getWorldQuaternion(b).normalize();
        maxAngle = Math.max(maxAngle, THREE.MathUtils.radToDeg(a.angleTo(b)));
      }
    }
    return {
      frameCount: times.length,
      boneCount: 52,
      maxWorldPositionErrorMetres: maxPosition,
      maxWorldRotationErrorDegrees: maxAngle,
      maxHipsPositionErrorMetres: maxHips,
      maxFootPositionErrorMetres: feet,
    };
  };
  const keys = measure(Array.from(baked.times));
  const midpoints = measure(
    Array.from(baked.times.slice(1), (time, i) => (baked.times[i] + time) / 2),
  );
  // Exact output sample fidelity and off-grid sampling loss are checked separately.
  if (keys.maxWorldPositionErrorMetres > 0.0001 || keys.maxWorldRotationErrorDegrees > 0.02)
    throw new Error(`Roundtrip failed: ${JSON.stringify(keys)}`);
  if (midpoints.maxWorldPositionErrorMetres > 0.005 || midpoints.maxWorldRotationErrorDegrees > 1)
    throw new Error(`30 Hz sampling loses excessive source detail: ${JSON.stringify(midpoints)}`);
  return {
    officialLoaderRestHipsMetres: animation.restHipsPosition.toArray(),
    officialRetargetAllValuesFinite: true,
    rotationTracks: animation.humanoidTracks.rotation.size,
    hipsTranslationTracks: animation.humanoidTracks.translation.size,
    outputKeyTimes: keys,
    betweenOutputKeys: midpoints,
  };
}

/** The caller supplies source and output paths; binaries are written only after validation. */
export async function prepareRecordedFbx({
  inputFbx,
  outputVrma,
  inPointSec,
  outPointSec,
  sampleHz = 30,
  expectedSourceSha256 = expectedConversationSha256,
  animationName = "Rokoko Conversation source-faithful",
  sourceProfile = "rokoko",
}) {
  if (sourceProfile !== "rokoko" && sourceProfile !== "mixamo")
    throw new Error("Unknown source preparation profile");
  if (path.resolve(inputFbx) === path.resolve(outputVrma) || path.extname(outputVrma) !== ".vrma")
    throw new Error("Output must be a separate VRMA path");
  const privateRoot =
    sourceProfile === "mixamo"
      ? path.join(projectRoot, ".motion-review")
      : path.dirname(defaultOutput);
  const relativeOutput = path.relative(privateRoot, path.resolve(outputVrma));
  if (relativeOutput.startsWith("..") || path.isAbsolute(relativeOutput))
    throw new Error(
      "Preparation binaries must remain in the profile's private .motion-review directory",
    );
  if (sampleHz !== 30) throw new Error("Only the reviewed 30 Hz preparation is supported");
  const buffer = await fs.readFile(inputFbx),
    sourceSha256 = hash(buffer);
  if (sourceSha256 !== expectedSourceSha256)
    throw new Error("Source hash does not match the reviewed recording");
  const source = sourceRig(buffer);
  const end = outPointSec ?? source.clip.duration;
  let originalTimes;
  if (sourceProfile === "mixamo") {
    if (inPointSec !== 0 || end !== source.clip.duration)
      throw new Error(
        "Mixamo intake preserves the complete source from zero; trimming is separate",
      );
    originalTimes = source.clip.tracks.reduce(
      (longest, track) => (track.times.length > longest.length ? track.times : longest),
      source.clip.tracks[0].times,
    );
    if (
      originalTimes[0] !== 0 ||
      originalTimes[originalTimes.length - 1] !== end ||
      originalTimes.some(
        (time, index) =>
          !Number.isFinite(time) ||
          (index > 0 &&
            (time <= originalTimes[index - 1] ||
              Math.abs(time - originalTimes[index - 1] - 1 / sampleHz) > 0.000003)),
      ) ||
      source.clip.tracks.some(
        (track) =>
          !(track.times.length === 1 && track.times[0] === 0) &&
          (track.times.length !== originalTimes.length ||
            track.times.some((time, index) => time !== originalTimes[index])),
      )
    )
      throw new Error(
        "Mixamo intake requires shared original 30 Hz keys or a constant zero-time pose",
      );
  } else if (!(Number.isFinite(inPointSec) && inPointSec >= 0.1 && end <= source.clip.duration))
    throw new Error(
      "Explicit in-point must exclude the reference prefix and remain in the source interval",
    );
  const baked = bake(source, inPointSec, end, sampleHz, originalTimes),
    binary = encodeVrma(source, baked, sourceSha256, animationName);
  const validation = await validateRoundtrip(buffer, binary, baked, inPointSec);
  const report = {
    schemaVersion: 1,
    sourceFile: path.basename(inputFbx),
    sourceSha256,
    outputFile: path.basename(outputVrma),
    outputSha256: hash(binary),
    outputBytes: binary.length,
    preparation: {
      ...(sourceProfile === "mixamo"
        ? {
            sourceProfile,
            sourceKeySampleHz: 30,
            originalKeyTimesPreserved: true,
            sourceTrackCount: source.clip.tracks.length,
            sourceNonFiniteValueCount: 0,
            constantSourceRotationTracks: source.clip.tracks
              .filter((track) => track.name.endsWith(".quaternion") && track.times.length === 1)
              .map((track) => track.name),
          }
        : {}),
      inPointSec,
      outPointSec: end,
      durationSec: baked.duration,
      sampleHz,
      frameCount: baked.times.length,
      sourceMetresPerUnit: source.metresPerUnit,
      initialXZOffsetRemovedMetres: baked.originOffset.toArray(),
      sourceRestHipsMetres: source.humanoid.normalizedRestPose.hips.position,
      rotationBoneCount: 52,
      fingerRotationBoneCount: 30,
      translation: "all authored hips XYZ variation; only a constant initial XZ offset removed",
      staticNonHipsTranslationsBakedIntoReference: source.staticTranslationOffsets,
      modifications:
        "Constant non-hips animation translations become reference bone offsets. No speed change, smoothing, loop conditioning, masking, or contact correction.",
    },
    validation:
      sourceProfile === "mixamo" ? { ...validation, nonFiniteOutputValueCount: 0 } : validation,
    method: {
      sourcePage:
        sourceProfile === "mixamo"
          ? "https://www.mixamo.com/"
          : "https://www.rokoko.com/resources/rokoko-mocap-10-free-everyday-idle-animations",
      ...(sourceProfile === "mixamo"
        ? {
            sourceDeclaration: "User-provided Adobe Mixamo download; original FBX SHA-256 recorded",
          }
        : { sourceArchive: "https://media.rokoko.com/EVERYDAY-IDLES-MOCAP.zip" }),
      loader: `Three.js r${THREE.REVISION} FBXLoader + official VRMAnimationLoaderPlugin/createVRMAnimationClip`,
      unitDefinition:
        "https://help.autodesk.com/cloudhelp/2020/ENU/FBX-API-Reference/cpp_ref/class_fbx_system_unit.html",
      reference:
        "Original FBX poses sampled on its own skeleton in metres, compared to official VRMA replay retargeted back onto a second identical source skeleton. Account for the one constant XZ offset before comparing all 52 bone world positions/orientations.",
      thresholds: {
        outputKeyPositionMetres: 0.0001,
        outputKeyRotationDegrees: 0.02,
        midpointPositionMetres: 0.005,
        midpointRotationDegrees: 1,
      },
      limitations: [
        "Source-fidelity gate only; Yori retargeting, perceived acting quality, contacts on a differently proportioned avatar, and cross-clip transitions require separate review.",
        sourceProfile === "mixamo"
          ? "Complete original source clock from zero is retained, including all 30 Hz keys. No reference prefix or semantic interval is inferred or removed. Original capture frame rate before Mixamo export is unknown."
          : "The explicit 0.1-second in-point excludes the measured reference-pose prefix. It is not a semantic segmentation or approved looping boundary.",
        "Foot metrics measure error relative to the authored source feet, not absolute foot sliding against the floor.",
        "Prepared binary is a private review artifact; no existing catalog, original asset, or distribution asset is replaced.",
      ],
    },
  };
  await fs.mkdir(path.dirname(outputVrma), { recursive: true });
  await fs.writeFile(outputVrma, binary);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputVrma = path.resolve(process.argv[3] ?? defaultOutput),
    reportPath = path.resolve(process.argv[4] ?? defaultReport);
  if (path.extname(reportPath) !== ".json") throw new Error("Report output must be JSON");
  const report = await prepareRecordedFbx({
    inputFbx: path.resolve(process.argv[2] ?? defaultSource),
    outputVrma,
    inPointSec: 0.1,
  });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ outputVrma, reportPath, validation: report.validation }, null, 2));
}

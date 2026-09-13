#!/usr/bin/env node
/** Read-only source FBX versus existing VRMA audit; never modifies either asset.
 * Usage: node scripts/audit-recorded-motion-ingest.mjs [fbx-directory] [vrma-directory] [report-json]
 * Obtain the original pack from the official URL recorded in the output report.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VRMAnimationLoaderPlugin } from "@pixiv/three-vrm-animation";
import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = path.resolve(
  process.argv[2] ??
    path.join(projectRoot, ".motion-review/source-assets/rokoko-everyday-original"),
);
const convertedDirectory = path.resolve(
  process.argv[3] ?? path.join(projectRoot, "public/animations"),
);
const output = path.resolve(
  process.argv[4] ?? path.join(projectRoot, "docs/decisions/recorded-motion-ingest-audit.json"),
);
if (path.extname(output) !== ".json")
  throw new Error("The audit output must be a JSON report, not an animation asset.");
const pairs = [
  ["Idle_LookingAround_MIXAMO_769", "Idle Looking Around"],
  ["Idle_LookingAround02_MIXAMO_769", "Idle Looking Around 2"],
  ["Idle_WatchingSomething_Loop_MIXAMO_769_segment", "Idle Watching Something"],
  ["Idle_Conversation_Loop_MIXAMO_769_segment-2", "Idle Conversation"],
  ["Idle_Chatting_MIXAMO_WHS", "Idle Chatting"],
  ["Idle_Chatting02_MIXAMO_WHS", "Idle Chatting 2"],
];
const mixamoNames = {
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
    mixamoNames[side + source] = lower + target;
  for (const finger of ["Thumb", "Index", "Middle", "Ring", "Pinky"]) {
    const target = finger === "Pinky" ? "Little" : finger;
    const segments =
      finger === "Thumb"
        ? ["Metacarpal", "Proximal", "Distal"]
        : ["Proximal", "Intermediate", "Distal"];
    segments.forEach((segment, i) => {
      mixamoNames[`${side}Hand${finger}${i + 1}`] = lower + target + segment;
    });
  }
}
const fingerPattern = /Thumb|Index|Middle|Ring|Little/;
const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
const round = (value) => Math.round(value * 1e7) / 1e7;
const quantile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * p)];
};
function keyTiming(tracks) {
  const intervals = [];
  let duplicates = 0;
  for (const track of tracks) {
    for (let i = 1; i < track.times.length; i++) {
      const interval = track.times[i] - track.times[i - 1];
      if (interval > 1e-7) intervals.push(interval);
      else duplicates++;
    }
  }
  const median = quantile(intervals, 0.5);
  return {
    trackCount: tracks.length,
    totalKeys: tracks.reduce((count, track) => count + track.times.length, 0),
    maxKeysPerTrack: Math.max(0, ...tracks.map((track) => track.times.length)),
    medianPositiveKeyIntervalSec: median === null ? null : round(median),
    reciprocalMedianIntervalHz: median === null ? null : round(1 / median),
    duplicateOrReversedTimeCount: duplicates,
  };
}
function positionRange(track, scale, afterTime = -Infinity) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  let keys = 0;
  for (let i = 0; i < track.times.length; i++) {
    if (track.times[i] < afterTime) continue;
    keys++;
    for (let axis = 0; axis < 3; axis++) {
      const value = track.values[i * 3 + axis] * scale;
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  return {
    keys,
    min: min.map(round),
    max: max.map(round),
    range: max.map((v, i) => round(v - min[i])),
  };
}
function normalizeSourceRotations(root, clip) {
  root.updateMatrixWorld(true);
  const mapped = new Map();
  root.traverse((bone) => {
    if (!bone.isBone) return;
    const name = mixamoNames[bone.name.replace(/^mixamorig:?/, "")];
    if (name) mapped.set(name, bone);
  });
  const normalized = new Map();
  for (const [name, bone] of mapped) {
    const track = clip.tracks.find((candidate) => candidate.name === `${bone.name}.quaternion`);
    if (!track) continue;
    // Same rest-world change of basis as VRMAnimationLoaderPlugin._parseAnimation.
    const parent = bone.parent.getWorldQuaternion(new THREE.Quaternion());
    const inverseRest = bone.getWorldQuaternion(new THREE.Quaternion()).invert();
    const q = new THREE.Quaternion(),
      values = new Float32Array(track.values.length);
    for (let i = 0; i < track.values.length; i += 4)
      q.fromArray(track.values, i)
        .premultiply(parent)
        .multiply(inverseRest)
        .normalize()
        .toArray(values, i);
    normalized.set(name, new THREE.QuaternionKeyframeTrack(name, track.times, values));
  }
  return { mapped, normalized };
}
function compareRotations(source, converted, duration) {
  const tracks = [...source]
    .filter(([name]) => converted.has(name))
    .map(([name, track]) => ({
      name,
      source: track.createInterpolant(),
      converted: converted.get(name).createInterpolant(),
    }));
  const a = new THREE.Quaternion(),
    b = new THREE.Quaternion();
  const evaluate = (offset, selected, samples) => {
    const errors = [];
    for (let i = 0; i < samples; i++) {
      // Stay clear of initial reference keys and either clip's final boundary.
      const time = 0.5 + ((duration - 1) * i) / Math.max(1, samples - 1);
      for (const track of selected) {
        a.fromArray(track.source.evaluate(time + offset)).normalize();
        b.fromArray(track.converted.evaluate(time)).normalize();
        errors.push(THREE.MathUtils.radToDeg(a.angleTo(b)));
      }
    }
    return {
      sampleBonePairs: errors.length,
      rmsDegrees: Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0) / errors.length),
      p95Degrees: quantile(errors, 0.95),
    };
  };
  const body = tracks.filter((track) => !fingerPattern.test(track.name));
  let bestOffset = 0,
    best = Infinity;
  for (let step = -60; step <= 60; step++) {
    const offset = step / 300,
      score = evaluate(offset, body, 16).rmsDegrees;
    if (score < best) {
      best = score;
      bestOffset = offset;
    }
  }
  return {
    bodyBoneCount: body.length,
    fingerBoneCount: tracks.length - body.length,
    unalignedBody: evaluate(0, body, 120),
    bestConstantSourceOffsetSec: round(bestOffset),
    alignedBody: evaluate(bestOffset, body, 120),
    alignedFingers: evaluate(
      bestOffset,
      tracks.filter((track) => fingerPattern.test(track.name)),
      120,
    ),
    searchReachedBoundary: Math.abs(bestOffset) === 0.2,
  };
}

const loader = new GLTFLoader();
loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
const clips = [];
for (const [sourceName, convertedName] of pairs) {
  const sourceBuffer = await fs.readFile(path.join(sourceDirectory, `${sourceName}.fbx`));
  const convertedBuffer = await fs.readFile(path.join(convertedDirectory, `${convertedName}.vrma`));
  const toArrayBuffer = (buffer) =>
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const root = new FBXLoader().parse(toArrayBuffer(sourceBuffer), "");
  const source = root.animations[0];
  const { mapped, normalized } = normalizeSourceRotations(root, source);
  const converted = (await loader.parseAsync(toArrayBuffer(convertedBuffer), "")).userData
    .vrmAnimations[0];
  const hips = mapped.get("hips"),
    hipsTrack = source.tracks.find((track) => track.name === `${hips.name}.position`);
  const unitScaleFactor = root.userData.unitScaleFactor;
  if (!(Number.isFinite(unitScaleFactor) && unitScaleFactor > 0))
    throw new Error(`Missing units: ${sourceName}`);
  const metresPerUnit = unitScaleFactor / 100;
  const sourceRotations = [...normalized.values()];
  const convertedRotations = [...converted.humanoidTracks.rotation.values()];
  const sourceBody = [...normalized]
    .filter(([name]) => !fingerPattern.test(name))
    .map(([, track]) => track);
  const initialPose = [0, 1 / 30, 2 / 30, 0.1].map((time) => {
    const angles = sourceBody.map((track) =>
      new THREE.Quaternion()
        .fromArray(track.createInterpolant().evaluate(time))
        .normalize()
        .angleTo(new THREE.Quaternion()),
    );
    return {
      timeSec: round(time),
      normalizedBodyAngleFromRestRmsDegrees: round(
        THREE.MathUtils.radToDeg(
          Math.sqrt(angles.reduce((sum, v) => sum + v * v, 0) / angles.length),
        ),
      ),
    };
  });
  const row = {
    sourceFile: `${sourceName}.fbx`,
    sourceSha256: hash(sourceBuffer),
    convertedFile: `${convertedName}.vrma`,
    convertedSha256: hash(convertedBuffer),
    source: {
      durationSec: source.duration,
      unitScaleFactor,
      metresPerUnit,
      restHipsWorldMetres: hips
        .getWorldPosition(new THREE.Vector3())
        .multiplyScalar(metresPerUnit)
        .toArray(),
      mappedBoneCount: mapped.size,
      fingerBoneCount: [...mapped.keys()].filter((name) => fingerPattern.test(name)).length,
      rotationTiming: keyTiming(sourceRotations),
      hipPositionTiming: keyTiming([hipsTrack]),
      hipPositionRangeMetres: positionRange(hipsTrack, metresPerUnit),
      hipPositionRangeAfterReferencePrefixMetres: positionRange(hipsTrack, metresPerUnit, 0.06),
      firstHipKeyTimesSec: Array.from(hipsTrack.times.slice(0, 4)),
      firstHipKeyPositionsMetres: Array.from(
        hipsTrack.values.slice(0, 12),
        (value) => value * metresPerUnit,
      ),
      initialPose,
    },
    converted: {
      durationSec: converted.duration,
      restHipsWorld: converted.restHipsPosition.toArray(),
      rotationTiming: keyTiming(convertedRotations),
      fingerRotationTrackCount: [...converted.humanoidTracks.rotation.keys()].filter((name) =>
        fingerPattern.test(name),
      ).length,
      hipTranslationTrackCount: converted.humanoidTracks.translation.has("hips") ? 1 : 0,
    },
    rotationDiagnostic: compareRotations(
      normalized,
      converted.humanoidTracks.rotation,
      Math.min(source.duration, converted.duration),
    ),
  };
  clips.push(row);
  console.log(
    `${convertedName}: hip translation present=${row.converted.hipTranslationTrackCount > 0}; source ${row.source.rotationTiming.reciprocalMedianIntervalHz} Hz / VRMA ${row.converted.rotationTiming.reciprocalMedianIntervalHz} Hz; aligned body RMS ${row.rotationDiagnostic.alignedBody.rmsDegrees.toFixed(2)} deg`,
  );
}
const report = {
  schemaVersion: 1,
  method: {
    sourcePage: "https://www.rokoko.com/resources/rokoko-mocap-10-free-everyday-idle-animations",
    sourceArchive: "https://media.rokoko.com/EVERYDAY-IDLES-MOCAP.zip",
    unitDefinition:
      "https://help.autodesk.com/cloudhelp/2020/ENU/FBX-API-Reference/cpp_ref/class_fbx_system_unit.html",
    sourceLoader: `Three.js r${THREE.REVISION} FBXLoader; source bones evaluated in their loaded rest hierarchy`,
    normalizedRotation:
      "parent rest world quaternion * source local animation quaternion * inverse(bone rest world quaternion), matching installed three-vrm-animation rest-basis conversion",
    timing:
      "Reciprocal median positive key interval, not guaranteed uniform export FPS; duplicates are counted separately.",
    rotationComparison:
      "120 times within [0.5, minDuration-0.5]; shortest quaternion angle. Constant source offset searched within +/-0.2 sec using body bones, no time scaling or per-bone fitting.",
    units: { position: "metres (FBX UnitScaleFactor / 100)", rotation: "degrees", time: "seconds" },
    limitations: [
      "This audits data retention and a diagnostic orientation comparison, not perceived naturalness, feet on the target avatar, or superiority over Animates.",
      "A best-fit time offset is not proof of the original converter settings; source pairs are identified by official filenames and repository credits, not a retained conversion manifest.",
      "The first source keys include a rest/reference pose and duplicate times. The 0.06-second exclusion only reports post-prefix ranges; it is not an approved clip in-point.",
      "No missing root movement is reconstructed from existing VRMA. No original source, converted asset, or production code is changed.",
    ],
  },
  clips,
};
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(
  output,
  `${JSON.stringify(report, (_key, value) => (typeof value === "number" ? round(value) : value), 2)}\n`,
);
console.log(`Wrote ${output}`);

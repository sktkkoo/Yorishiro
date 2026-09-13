#!/usr/bin/env node
/** Trim the reviewed 30 Hz recording on its existing sample boundaries.
 * node scripts/prepare-idle-survey.mjs
 * Private output only. No source modifications, new motion, or loop repair.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { glbParts, loadAnimation } from "./measure-conversation-retarget.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const input = path.join(root, ".motion-review/source-assets/prepared/Idle Looking Around 2.vrma");
const output = path.join(root, ".motion-review/source-assets/prepared/survey.vrma");
const expected = "8dfcb799514bdf9dd4b1e739b31b67270216e09e9b81ac24ba75ea3ac3baf8d7";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytes = await fs.readFile(input);
if (hash(bytes) !== expected) throw new Error("Reviewed source SHA256 mismatch");
const { json, bin } = glbParts(bytes);
const animation = json.animations[0];
if (json.animations.length !== 1 || animation.channels.length !== 53)
  throw new Error("Expected the reviewed 52 rotations and hips translation");
const read = (index) => {
  const accessor = json.accessors[index];
  const view = json.bufferViews[accessor.bufferView];
  const width = { SCALAR: 1, VEC3: 3, VEC4: 4 }[accessor.type];
  if (accessor.componentType !== 5126 || accessor.sparse || view.byteStride || !width)
    throw new Error("Unsupported source accessor");
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return {
    type: accessor.type,
    width,
    values: Float32Array.from({ length: accessor.count * width }, (_, i) =>
      bin.readFloatLE(offset + i * 4),
    ),
  };
};
const first = 174; // 5.8 seconds at 30 Hz, excluding the original source setup.
const last = 915; // 30.5 seconds; hand has returned before the faulty low-arm tail.
const sourceTimes = read(animation.samplers[0].input).values;
if (Math.abs(sourceTimes[first] - 5.8) > 1e-6 || Math.abs(sourceTimes[last] - 30.5) > 1e-6)
  throw new Error("Source sample boundaries changed");
const origin = sourceTimes[first];
const times = Float32Array.from(sourceTimes.slice(first, last + 1), (time) => time - origin);
if (times.some((time, index) => !Number.isFinite(time) || (index > 0 && time <= times[index - 1])))
  throw new Error("Trimmed times must be finite and strictly increasing");
const trimmed = animation.samplers.map((sampler) => {
  const inputTimes = read(sampler.input).values;
  if (
    sampler.interpolation !== "LINEAR" ||
    inputTimes.length !== sourceTimes.length ||
    inputTimes.some((time, i) => time !== sourceTimes[i])
  )
    throw new Error("Source channels must share the reviewed 30 Hz clock");
  const data = read(sampler.output);
  return { ...data, values: data.values.slice(first * data.width, (last + 1) * data.width) };
});
json.accessors = [];
json.bufferViews = [];
const chunks = [];
let byteLength = 0;
const add = (values, type) => {
  const buffer = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
  const view = json.bufferViews.length;
  json.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: buffer.length });
  chunks.push(buffer);
  byteLength += buffer.length;
  const index = json.accessors.length;
  json.accessors.push({
    bufferView: view,
    componentType: 5126,
    count: values.length / { SCALAR: 1, VEC3: 3, VEC4: 4 }[type],
    type,
    ...(type === "SCALAR" ? { min: [0], max: [times[times.length - 1]] } : {}),
  });
  return index;
};
const timeAccessor = add(times, "SCALAR");
animation.samplers = trimmed.map(({ values, type }) => ({
  input: timeAccessor,
  output: add(values, type),
  interpolation: "LINEAR",
}));
animation.name = "Rokoko finite head-high survey";
json.buffers = [{ byteLength }];
json.extras.reviewedUnit = {
  sourcePreparedSha256: expected,
  startSec: origin,
  endSec: sourceTimes[last],
  loop: false,
  publicRef: "/animations/recorded-idle/survey.vrma",
  scope:
    "Finite upper-body performance. Full source body/finger tracks and hips XYZ are retained; no target contact adaptation is implied.",
};
const rawJson = Buffer.from(JSON.stringify(json));
const jsonBytes = Buffer.alloc(Math.ceil(rawJson.length / 4) * 4, 0x20);
rawJson.copy(jsonBytes);
const binary = Buffer.concat(chunks),
  header = Buffer.alloc(20),
  binHeader = Buffer.alloc(8);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(28 + jsonBytes.length + binary.length, 8);
header.writeUInt32LE(jsonBytes.length, 12);
header.writeUInt32LE(0x4e4f534a, 16);
binHeader.writeUInt32LE(binary.length, 0);
binHeader.writeUInt32LE(0x004e4942, 4);
const result = Buffer.concat([header, jsonBytes, binHeader, binary]);
const source = await loadAnimation(bytes),
  replay = await loadAnimation(result);
let maxRotationDegrees = 0,
  maxTranslationMetres = 0;
let checkedSamples = 0;
for (const kind of ["rotation", "translation"]) {
  for (const [bone, track] of source.humanoidTracks[kind]) {
    const other = replay.humanoidTracks[kind].get(bone);
    if (!other || other.times.length !== times.length) throw new Error(`Missing channel: ${bone}`);
    if (other.values.some((value, i) => value !== track.values[first * track.getValueSize() + i]))
      throw new Error(`Changed authored key: ${bone}`);
    const a = track.createInterpolant(),
      b = other.createInterpolant();
    for (let index = 0; index <= Math.ceil(replay.duration * 120); index++) {
      const time = Math.min(index / 120, replay.duration);
      const av = a.evaluate(Math.min(origin + time, sourceTimes[last])),
        bv = b.evaluate(time);
      if (kind === "rotation")
        maxRotationDegrees = Math.max(
          maxRotationDegrees,
          THREE.MathUtils.radToDeg(
            new THREE.Quaternion()
              .fromArray(av)
              .normalize()
              .angleTo(new THREE.Quaternion().fromArray(bv).normalize()),
          ),
        );
      else
        maxTranslationMetres = Math.max(
          maxTranslationMetres,
          new THREE.Vector3().fromArray(av).distanceTo(new THREE.Vector3().fromArray(bv)),
        );
      checkedSamples++;
    }
  }
}
if (maxRotationDegrees > 0.001 || maxTranslationMetres > 0.00001)
  throw new Error("Trim changed source interpolation beyond float timestamp tolerance");
const report = {
  schemaVersion: 1,
  source: {
    file: path.relative(root, input),
    sha256: expected,
    originalFbxSha256: json.extras.sourceSha256,
  },
  output: { file: path.relative(root, output), sha256: hash(result), bytes: result.length },
  unit: json.extras.reviewedUnit,
  durationSec: replay.duration,
  frameCount: times.length,
  sampleHz: 30,
  validation: {
    exactAuthoredKeyValues: true,
    strictlyIncreasingTimes: true,
    rotationTracks: replay.humanoidTracks.rotation.size,
    fingerTracks: [...replay.humanoidTracks.rotation.keys()].filter((name) =>
      /Thumb|Index|Middle|Ring|Little/.test(name),
    ).length,
    hipsTranslationTracks: replay.humanoidTracks.translation.size,
    sampleHz: 120,
    checkedSamples,
    maxRotationDegrees,
    maxTranslationMetres,
  },
};
await fs.writeFile(output, result);
await fs.writeFile(
  path.join(root, ".motion-review/idle-survey-preparation.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));

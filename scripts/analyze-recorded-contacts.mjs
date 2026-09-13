#!/usr/bin/env node
/** Source-bone contact candidates, not semantic gesture boundaries or contact ground truth.
 * node scripts/analyze-recorded-contacts.mjs [report-json] [optional-vrma-filename]
 * Requires prepare-recorded-library.mjs outputs; never changes a recording.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createVRMAnimationClip } from "@pixiv/three-vrm-animation";
import * as THREE from "three";
import { createRig, loadAnimation } from "./measure-conversation-retarget.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE_HZ = 60;
const CONTACT_SPEED = 0.04;
const CONTACT_HEIGHT = 0.015;
const MIN_INTERVAL_SEC = 0.25;
const sides = ["left", "right"];
const contactJoints = ["hips", "leftFoot", "leftToes", "rightFoot", "rightToes"];
const bodyJoints = [
  "hips",
  "spine",
  "chest",
  "upperChest",
  "neck",
  "head",
  ...sides.flatMap((side) =>
    ["Shoulder", "UpperArm", "LowerArm", "Hand", "UpperLeg", "LowerLeg", "Foot", "Toes"].map(
      (part) => side + part,
    ),
  ),
];
const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
const norm = (values) => Math.hypot(...values);
const subtract = (a, b, dt) => a.map((value, axis) => (value - b[axis]) / dt);
const round = (value) => Math.round(value * 1e8) / 1e8;

function angularVelocity(a, b, dt) {
  const delta = new THREE.Quaternion()
    .fromArray(a)
    .invert()
    .premultiply(new THREE.Quaternion().fromArray(b))
    .normalize();
  if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
  const sinHalf = Math.hypot(delta.x, delta.y, delta.z);
  const factor = sinHalf > 1e-10 ? (2 * Math.atan2(sinHalf, delta.w)) / (sinHalf * dt) : 0;
  return [delta.x * factor, delta.y * factor, delta.z * factor];
}

/** Exact clip-local 60Hz source-rig samples, reusable by target adaptation diagnostics. */
export async function sampleRecordedContactFrames(input) {
  const buffer = await fs.readFile(input);
  const rig = await createRig(buffer, false);
  const animation = await loadAnimation(buffer);
  const clip = createVRMAnimationClip(animation, rig);
  if (!Number.isFinite(clip.duration) || clip.duration <= 0)
    throw new Error("Source recording duration must be finite and positive");
  if (!clip.tracks.every((track) => track.values.every(Number.isFinite)))
    throw new Error("Non-finite source replay");
  const mixer = new THREE.AnimationMixer(rig.scene);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const frames = [];
  const point = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  for (let index = 0; index <= Math.ceil(clip.duration * SAMPLE_HZ); index++) {
    const timeSec = Math.min(index / SAMPLE_HZ, clip.duration);
    mixer.setTime(timeSec);
    rig.humanoid.update();
    rig.scene.updateMatrixWorld(true);
    const joints = Object.fromEntries(
      contactJoints.map((name) => {
        const node = rig.humanoid.getNormalizedBoneNode(name);
        if (!node) throw new Error(`Source bone missing: ${name}`);
        return [
          name,
          {
            position: node.getWorldPosition(point).toArray(),
            rotation: node.getWorldQuaternion(rotation).toArray(),
            localRotation: node.quaternion.toArray(),
          },
        ];
      }),
    );
    const localRotations = Object.fromEntries(
      bodyJoints.flatMap((name) => {
        const node = rig.humanoid.getNormalizedBoneNode(name);
        return node ? [[name, node.quaternion.toArray()]] : [];
      }),
    );
    frames.push({ timeSec, joints, localRotations });
  }
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    const before = frames[Math.max(0, index - 1)];
    const after = frames[Math.min(frames.length - 1, index + 1)];
    const dt = after.timeSec - before.timeSec;
    for (const name of contactJoints) {
      frame.joints[name].linearVelocity = subtract(
        after.joints[name].position,
        before.joints[name].position,
        dt,
      );
      frame.joints[name].angularVelocity = angularVelocity(
        before.joints[name].rotation,
        after.joints[name].rotation,
        dt,
      );
      frame.joints[name].localAngularVelocity = angularVelocity(
        before.joints[name].localRotation,
        after.joints[name].localRotation,
        dt,
      );
    }
    const velocities = Object.keys(frame.localRotations).map((name) =>
      norm(angularVelocity(before.localRotations[name], after.localRotations[name], dt)),
    );
    frame.bodyAngularRmsRadSec = Math.sqrt(
      velocities.reduce((sum, value) => sum + value * value, 0) / velocities.length,
    );
  }
  mixer.stopAllAction();
  return { sha256: hash(buffer), durationSec: clip.duration, sampleHz: SAMPLE_HZ, frames };
}

function intervals(frames, accepts) {
  const result = [];
  let start = null;
  for (let index = 0; index <= frames.length; index++) {
    if (index < frames.length && accepts(index)) {
      if (start === null) start = index;
    } else if (start !== null) {
      const end = index - 1;
      if (frames[end].timeSec - frames[start].timeSec >= MIN_INTERVAL_SEC)
        result.push({ start, end });
      start = null;
    }
  }
  return result;
}

function positionExcursion(frames, joint) {
  const positions = frames.map((frame) => frame.joints[joint].position);
  const origin = positions[0];
  return {
    positionRangeMetres: [0, 1, 2].map(
      (axis) =>
        Math.max(...positions.map((point) => point[axis])) -
        Math.min(...positions.map((point) => point[axis])),
    ),
    maxHorizontalDisplacementFromStartMetres: Math.max(
      ...positions.map((point) => Math.hypot(point[0] - origin[0], point[2] - origin[2])),
    ),
  };
}

export async function analyzeRecordedContacts({
  input,
  expectedSha256,
  sourceSha256,
  inPointSec = 0.1,
}) {
  const sampled = await sampleRecordedContactFrames(input);
  if (expectedSha256 && expectedSha256 !== sampled.sha256)
    throw new Error(`Hash mismatch: ${input}`);
  const frames = sampled.frames;
  const lows = Object.fromEntries(
    contactJoints
      .filter((name) => name !== "hips")
      .map((name) => [name, Math.min(...frames.map((frame) => frame.joints[name].position[1]))]),
  );
  const flags = Object.fromEntries(
    sides.map((side) => [
      side,
      frames.map((frame) =>
        [`${side}Foot`, `${side}Toes`].every(
          (name) =>
            norm(frame.joints[name].linearVelocity) < CONTACT_SPEED &&
            frame.joints[name].position[1] <= lows[name] + CONTACT_HEIGHT,
        ),
      ),
    ]),
  );
  const contacts = Object.fromEntries(
    sides.map((side) => [
      side,
      intervals(frames, (index) => flags[side][index]).map(({ start, end }) => {
        const window = frames.slice(start, end + 1);
        return {
          startSec: frames[start].timeSec,
          endSec: frames[end].timeSec,
          footSpeedMaxMetresPerSec: Math.max(
            ...window.map((frame) => norm(frame.joints[`${side}Foot`].linearVelocity)),
          ),
          toeSpeedMaxMetresPerSec: Math.max(
            ...window.map((frame) => norm(frame.joints[`${side}Toes`].linearVelocity)),
          ),
          footHeightAboveLowMaxMetres: Math.max(
            ...window.map((frame) => frame.joints[`${side}Foot`].position[1] - lows[`${side}Foot`]),
          ),
          toeHeightAboveLowMaxMetres: Math.max(
            ...window.map((frame) => frame.joints[`${side}Toes`].position[1] - lows[`${side}Toes`]),
          ),
          footExcursion: positionExcursion(window, `${side}Foot`),
          toeExcursion: positionExcursion(window, `${side}Toes`),
        };
      }),
    ]),
  );
  const bothIntervals = intervals(frames, (index) => flags.left[index] && flags.right[index]);
  contacts.both = bothIntervals.map(({ start, end }) => ({
    startSec: frames[start].timeSec,
    endSec: frames[end].timeSec,
  }));
  const candidateIndices = new Set();
  for (const { start, end } of bothIntervals) {
    // Stay inside observed support for at least 100ms on either side; rank
    // local quiet poses, without calling them the preparation or end of a gesture.
    const inside = [];
    for (let index = start; index <= end; index++) {
      if (
        frames[index].timeSec - frames[start].timeSec >= 0.1 &&
        frames[end].timeSec - frames[index].timeSec >= 0.1
      )
        inside.push(index);
    }
    if (!inside.length) continue;
    candidateIndices.add(inside[0]);
    candidateIndices.add(inside[inside.length - 1]);
    inside.sort((a, b) => frames[a].bodyAngularRmsRadSec - frames[b].bodyAngularRmsRadSec);
    let selected = 0;
    for (const index of inside) {
      if (
        [...candidateIndices].some(
          (other) => Math.abs(frames[other].timeSec - frames[index].timeSec) < 0.8,
        )
      )
        continue;
      candidateIndices.add(index);
      if (++selected >= 3) break;
    }
  }
  const boundaryCandidates = [...candidateIndices]
    .sort((a, b) => a - b)
    .map((index) => ({
      timeSec: frames[index].timeSec,
      support: "both",
      bodyAngularRmsRadSec: frames[index].bodyAngularRmsRadSec,
      joints: frames[index].joints,
    }));
  return {
    file: path.basename(input),
    sha256: sampled.sha256,
    sourceSha256,
    durationSec: sampled.durationSec,
    inPointSec,
    sampleHz: SAMPLE_HZ,
    sourceLowBoneHeightsMetres: lows,
    contacts,
    boundaryCandidates,
  };
}

async function main() {
  const reportPath = path.resolve(
    process.argv[2] ?? path.join(root, "docs/decisions/recorded-contact-candidates.json"),
  );
  const filter = process.argv[3];
  const library = JSON.parse(
    await fs.readFile(
      path.join(root, "docs/decisions/source-faithful-library-metrics.json"),
      "utf8",
    ),
  );
  const recordings = [];
  for (const source of library.recordings) {
    if (filter && source.outputFile !== filter) continue;
    if (path.basename(source.outputFile) !== source.outputFile)
      throw new Error("Invalid recording filename");
    const recording = await analyzeRecordedContacts({
      input: path.join(root, ".motion-review/source-assets/prepared", source.outputFile),
      expectedSha256: source.outputSha256,
      sourceSha256: source.sourceSha256,
      inPointSec: source.preparation.inPointSec,
    });
    recordings.push(recording);
    console.log(
      JSON.stringify({
        file: recording.file,
        durationSec: recording.durationSec,
        left: recording.contacts.left,
        right: recording.contacts.right,
        both: recording.contacts.both,
        candidates: recording.boundaryCandidates.map(({ timeSec, bodyAngularRmsRadSec }) => ({
          timeSec,
          bodyAngularRmsRadSec,
        })),
      }),
    );
  }
  if (!recordings.length) throw new Error("No matching prepared recordings");
  const report = {
    schemaVersion: 1,
    method: {
      sampleHz: SAMPLE_HZ,
      source:
        "Official VRMA replay on each source skeleton, full hips XYZ, no target IK, masking, loop conditioning or runtime layers.",
      supportProxy: {
        maxFootAndToeSpeedMetresPerSec: CONTACT_SPEED,
        maxHeightAboveEachBoneClipMinimumMetres: CONTACT_HEIGHT,
        minIntervalSec: MIN_INTERVAL_SEC,
      },
      boundaryCandidatePolicy:
        "Both-source-support interior; 100ms margins. Endpoint coverage plus up to three low body-angular-speed poses per interval, 800ms separation.",
      coordinates:
        "Source-skeleton world metres/quaternions and world linear/angular velocity; localRotation/localAngularVelocity use normalized-parent axes. Clip-local seconds; original FBX time adds inPointSec.",
      limitations: [
        "Kinematic candidates, not measured sole contact, support force, balance or semantic gesture boundaries.",
        "Low points are per-clip bone minima, not a known floor. A motion requiring a wall/prop is not made eligible by quiet feet.",
        "Source contacts do not certify target-avatar contacts or cross-clip compatibility. Align roots and compare both target feet before admitting a transition.",
        "A quiet pose may be in the middle of an authored performance. Review entry/exit together before trimming.",
        "Low instantaneous speed does not establish a stationary contact anchor. Per-interval excursion exposes cumulative drift; intervals are unchanged by that diagnostic.",
      ],
    },
    recordings,
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    reportPath,
    `${JSON.stringify(
      report,
      (_key, value) => {
        if (typeof value !== "number") return value;
        if (!Number.isFinite(value)) throw new Error("Non-finite contact measurement");
        return round(value);
      },
      2,
    )}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();

#!/usr/bin/env node
/** Offline target adaptation for source-derived support episodes. Original assets are read-only.
 * node scripts/adapt-recorded-contacts.mjs [contact-report.json] [clip name ...]
 * Around requires --reviewed-unit around-idle; --diagnostic never approves playback.
 * Produces private finite full-body assets; no runtime/catalog/loop modification.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createVRMAnimationClip } from "@pixiv/three-vrm-animation";
import * as THREE from "three";
import { createRig, glbParts, loadAnimation } from "./measure-conversation-retarget.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelPath = path.join(root, "public/models/Yori.vrm");
const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
const hz = 60;
const rampSec = 0.35;
const minimumSupportSec = 2;
const maximumSourceSupportExcursionMetres = 0.015;
const sides = ["left", "right"];
const changedBones = sides.flatMap((side) => [`${side}UpperLeg`, `${side}LowerLeg`, `${side}Foot`]);
const vector = (values) => new THREE.Vector3().fromArray(values);
const ease = (value) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * t * (10 + t * (-15 + 6 * t));
};
const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)] ?? null;
const defaultBounds = Object.freeze({
  rootCorrectionMetres: 0.03,
  independentAnkleMetres: 0.015,
  localRotationDegrees: 8,
  reachPaddingMetres: 0.005,
  reachProjectionMetres: 0.01,
  soleErrorMetres: 0.0005,
  contactCenterErrorMetres: 0.0005,
  footWorldRotationDegrees: 0.05,
});

const reviewedUnits = Object.freeze({
  "around-idle": Object.freeze({
    sourceSha256: "511897677730015f7a7c5308ab1a15edf9cf05454ceea1755a143e49f1e15661",
    windows: [
      { id: "around-idle-early", startSec: 7.08333333, endSec: 15.66666667 },
      { id: "around-idle-middle", startSec: 15.66666667, endSec: 23.36666667 },
    ],
    localRotationDegrees: 13.1,
    review:
      "Actual Yori front/oblique samples checked; a continuous 24 fps comparison artifact is retained. No new inversion or crouch in reviewed samples. Knee contour is partly hidden by clothing. Playback is limited to the listed units and still requires runtime blend/contact gates.",
  }),
});

function evaluator(rig, animation, restoreModified = false) {
  const clip = createVRMAnimationClip(animation, rig),
    mixer = new THREE.AnimationMixer(rig.scene);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  return (time) => {
    // IK edits mixer-owned properties. Rebind before sampling so Three's
    // unchanged-value cache cannot preserve a previous frame's correction.
    if (restoreModified) {
      action.stop();
      action.reset().play();
    }
    action.paused = false;
    mixer.setTime(time);
    rig.humanoid.update();
    rig.scene.updateMatrixWorld(true);
  };
}
function positions(rig) {
  return Object.fromEntries(
    [
      "hips",
      ...sides.flatMap((side) => [
        `${side}UpperLeg`,
        `${side}LowerLeg`,
        `${side}Foot`,
        `${side}Toes`,
      ]),
    ].map((name) => [
      name,
      rig.humanoid.getNormalizedBoneNode(name).getWorldPosition(new THREE.Vector3()).toArray(),
    ]),
  );
}
function setWorldQuaternion(node, world) {
  node.quaternion
    .copy(node.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(world))
    .normalize();
  node.updateWorldMatrix(false, true);
}
function solveLeg(rig, side, target, footWorld, counters) {
  const upper = rig.humanoid.getNormalizedBoneNode(`${side}UpperLeg`),
    lower = rig.humanoid.getNormalizedBoneNode(`${side}LowerLeg`),
    foot = rig.humanoid.getNormalizedBoneNode(`${side}Foot`);
  const h = upper.getWorldPosition(new THREE.Vector3()),
    k = lower.getWorldPosition(new THREE.Vector3()),
    a = foot.getWorldPosition(new THREE.Vector3());
  const upperLength = h.distanceTo(k),
    lowerLength = k.distanceTo(a),
    direction = target.clone().sub(h);
  const distance = direction.length();
  direction.normalize();
  if (distance >= upperLength + lowerLength || distance <= Math.abs(upperLength - lowerLength))
    throw new Error("Unreachable leg target");
  const pole = k.clone().sub(h).addScaledVector(direction, -k.clone().sub(h).dot(direction));
  if (pole.length() < 1e-5) throw new Error(`Ambiguous authored knee pole: ${side}`);
  pole.normalize();
  const x =
    (upperLength * upperLength - lowerLength * lowerLength + distance * distance) / (2 * distance);
  const knee = h
    .clone()
    .addScaledVector(direction, x)
    .addScaledVector(pole, Math.sqrt(Math.max(0, upperLength * upperLength - x * x)));
  const upperWorld = upper.getWorldQuaternion(new THREE.Quaternion());
  const upperDelta = new THREE.Quaternion().setFromUnitVectors(
    k.clone().sub(h).normalize(),
    knee.clone().sub(h).normalize(),
  );
  setWorldQuaternion(upper, upperDelta.multiply(upperWorld));
  const currentKnee = lower.getWorldPosition(new THREE.Vector3()),
    currentAnkle = foot.getWorldPosition(new THREE.Vector3());
  const lowerWorld = lower.getWorldQuaternion(new THREE.Quaternion());
  const lowerDelta = new THREE.Quaternion().setFromUnitVectors(
    currentAnkle.sub(currentKnee).normalize(),
    target.clone().sub(currentKnee).normalize(),
  );
  setWorldQuaternion(lower, lowerDelta.multiply(lowerWorld));
  setWorldQuaternion(foot, footWorld);
  counters.maxAnkleSolveErrorMetres = Math.max(
    counters.maxAnkleSolveErrorMetres,
    foot.getWorldPosition(new THREE.Vector3()).distanceTo(target),
  );
  const solvedPole = lower.getWorldPosition(new THREE.Vector3()).sub(h);
  solvedPole.addScaledVector(direction, -solvedPole.dot(direction)).normalize();
  counters.minimumAuthoredPoleAgreement = Math.min(
    counters.minimumAuthoredPoleAgreement,
    solvedPole.dot(pole),
  );
}
function encode(sourceBuffer, times, hips, rotations, metadata) {
  const { json, bin } = glbParts(sourceBuffer),
    chunks = [bin];
  let offset = bin.length;
  const accessor = (values, type) => {
    const buffer = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buffer.length });
    chunks.push(buffer);
    offset += buffer.length;
    const index = json.accessors.length;
    json.accessors.push({
      bufferView: json.bufferViews.length - 1,
      componentType: 5126,
      count: values.length / { SCALAR: 1, VEC3: 3, VEC4: 4 }[type],
      type,
      ...(type === "SCALAR" ? { min: [times[0]], max: [times[times.length - 1]] } : {}),
    });
    return index;
  };
  const timeAccessor = accessor(times, "SCALAR"),
    animation = json.animations[0];
  for (const [name, values] of [["hips", hips], ...rotations]) {
    const targetPath = name === "hips" ? "translation" : "rotation";
    const channel = animation.channels.find(
      (channel) =>
        channel.target.node === json.extensions.VRMC_vrm_animation.humanoid.humanBones[name].node &&
        channel.target.path === targetPath,
    );
    channel.sampler = animation.samplers.length;
    animation.samplers.push({
      input: timeAccessor,
      output: accessor(values, name === "hips" ? "VEC3" : "VEC4"),
      interpolation: "LINEAR",
    });
  }
  animation.name = "Yori contact-adapted recorded motion";
  json.asset.generator = "Yorishiro bounded target contact adaptation";
  json.extras ??= {};
  json.extras.targetAdaptation = metadata;
  json.buffers[0].byteLength = offset;
  const raw = Buffer.from(JSON.stringify(json)),
    jsonBytes = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 0x20);
  raw.copy(jsonBytes);
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
  return Buffer.concat([header, jsonBytes, binHeader, binary]);
}

function validatedEpisodes(contacts, duration, frames) {
  const episodes = {};
  for (const side of sides) {
    let previousEnd = -Infinity;
    episodes[side] = (contacts[side] ?? []).map((entry) => {
      const { startSec, endSec } = entry;
      if (
        ![startSec, endSec].every(Number.isFinite) ||
        startSec < 0 ||
        endSec > duration + 1e-5 ||
        endSec <= startSec ||
        startSec < previousEnd
      )
        throw new Error(`Invalid ${side} support interval`);
      previousEnd = endSec;
      const frame = frames[Math.min(frames.length - 1, Math.round(startSec * hz))];
      const anchor = vector(frame.points[`${side}Foot`])
        .add(vector(frame.points[`${side}Toes`]))
        .multiplyScalar(0.5);
      const sourceExcursionMetres = Math.max(
        entry.footExcursion?.maxHorizontalDisplacementFromStartMetres ?? Infinity,
        entry.toeExcursion?.maxHorizontalDisplacementFromStartMetres ?? Infinity,
      );
      const enabled =
        endSec - startSec >= minimumSupportSec &&
        sourceExcursionMetres <= maximumSourceSupportExcursionMetres;
      return {
        startSec,
        endSec,
        anchor,
        sourceExcursionMetres: Number.isFinite(sourceExcursionMetres)
          ? sourceExcursionMetres
          : null,
        enabled,
        skipReason: enabled
          ? null
          : endSec - startSec < minimumSupportSec
            ? "short-support-preserved"
            : "source-excursion-unverified-or-excessive",
      };
    });
  }
  return episodes;
}
function episodeAt(episodes, time) {
  return episodes.find(
    (episode) => episode.enabled && time >= episode.startSec && time <= episode.endSec,
  );
}
function supportAt(episodes, time) {
  const episode = episodeAt(episodes, time);
  return {
    episode,
    weight: episode
      ? ease((time - episode.startSec) / rampSec) * ease((episode.endSec - time) / rampSec)
      : 0,
  };
}
function prepareFrame(frame, episodes) {
  frame.support = Object.fromEntries(
    sides.map((side) => [side, supportAt(episodes[side], frame.time)]),
  );
  frame.desired = {};
  for (const side of sides) {
    const center = vector(frame.points[`${side}Foot`])
      .add(vector(frame.points[`${side}Toes`]))
      .multiplyScalar(0.5);
    const anchor = frame.support[side].episode?.anchor ?? center;
    frame.desired[side] = new THREE.Vector3(
      anchor.x - center.x,
      -frame.soles[side],
      anchor.z - center.z,
    );
  }
}
function frameTargets(frame, padding) {
  const weights = sides.map((side) => frame.support[side].weight);
  const delta = new THREE.Vector3();
  sides.forEach((side, i) => {
    delta.addScaledVector(frame.desired[side], weights[i]);
  });
  delta.divideScalar(Math.max(1, weights[0] + weights[1]));
  delta.y -= padding * Math.max(...weights);
  const beforeReach = delta.clone();
  // Bounded feasible pelvis correction, retaining the recorded knee plane.
  // Correct only excess extension; never narrow the recorded stance.
  for (let iteration = 0; iteration < 24; iteration++) {
    let projected = false;
    for (const side of sides) {
      const weight = frame.support[side].weight;
      if (weight < 1e-6) continue;
      const h = vector(frame.points[`${side}UpperLeg`]),
        k = vector(frame.points[`${side}LowerLeg`]),
        a = vector(frame.points[`${side}Foot`]);
      const maximum = h.distanceTo(k) + k.distanceTo(a) - 0.000021;
      const leg = a.sub(h).addScaledVector(frame.desired[side].clone().sub(delta), weight);
      const distance = leg.length();
      if (distance > maximum) {
        delta.addScaledVector(leg.normalize(), (distance - maximum) / weight);
        projected = true;
      }
    }
    if (!projected) break;
  }
  const targets = Object.fromEntries(
    sides.map((side, i) => [
      side,
      vector(frame.points[`${side}Foot`])
        .add(delta)
        .addScaledVector(frame.desired[side].clone().sub(delta), weights[i]),
    ]),
  );
  return {
    delta,
    targets,
    reachAdjustment: delta.clone().sub(beforeReach),
  };
}
function isReachable(frame, padding) {
  const { delta, targets } = frameTargets(frame, padding);
  for (const side of sides) {
    if (frame.support[side].weight <= 0) continue;
    const h = vector(frame.points[`${side}UpperLeg`]),
      k = vector(frame.points[`${side}LowerLeg`]),
      a = vector(frame.points[`${side}Foot`]);
    const max = h.distanceTo(k) + k.distanceTo(a) - 0.00002;
    const min = Math.abs(h.distanceTo(k) - k.distanceTo(a)) + 0.00002;
    const distance = h.add(delta).distanceTo(targets[side]);
    if (distance > max || distance < min) return false;
  }
  return true;
}
function preservedOtherTracks(original, adapted) {
  for (const [name, track] of original.humanoidTracks.rotation) {
    if (changedBones.includes(name)) continue;
    const other = adapted.humanoidTracks.rotation.get(name);
    if (
      !other ||
      !["times", "values"].every((key) =>
        Buffer.from(track[key].buffer, track[key].byteOffset, track[key].byteLength).equals(
          Buffer.from(other[key].buffer, other[key].byteOffset, other[key].byteLength),
        ),
      )
    )
      return false;
  }
  return true;
}
const angleDegrees = (a, b) => THREE.MathUtils.radToDeg(a.angleTo(b));
function safeBothWindows(episodes) {
  const windows = [];
  for (const left of episodes.left.filter((e) => e.enabled))
    for (const right of episodes.right.filter((e) => e.enabled)) {
      const startSec = Math.max(left.startSec, right.startSec) + rampSec;
      const endSec = Math.min(left.endSec, right.endSec) - rampSec;
      if (endSec - startSec >= 0.1) windows.push({ startSec, endSec, feet: "both" });
    }
  return windows;
}
function hipMotionMetrics(sourceFrames, adaptedFrames) {
  return ["x", "y", "z"].map((axis, index) => {
    const a = sourceFrames.map((f) => f.points.hips[index]),
      b = adaptedFrames.map((f) => f.points.hips[index]);
    const avg = (values) => values.reduce((s, v) => s + v, 0) / values.length;
    const ma = avg(a),
      mb = avg(b);
    const cov = avg(a.map((v, i) => (v - ma) * (b[i] - mb))),
      va = avg(a.map((v) => (v - ma) ** 2)),
      vb = avg(b.map((v) => (v - mb) ** 2));
    return {
      axis,
      sourceRangeMetres: Math.max(...a) - Math.min(...a),
      adaptedRangeMetres: Math.max(...b) - Math.min(...b),
      correlation: va > 1e-12 && vb > 1e-12 ? cov / Math.sqrt(va * vb) : null,
      meanOffsetMetres: mb - ma,
      timeVaryingCorrectionRangeMetres:
        Math.max(...a.map((value, i) => b[i] - value)) -
        Math.min(...a.map((value, i) => b[i] - value)),
    };
  });
}
function trajectoryWindowMetrics(frames, window) {
  const samples = frames.filter(
    (frame) => frame.time >= window.startSec && frame.time <= window.endSec,
  );
  const source = samples.map((frame) => ({ time: frame.time, points: frame.sourcePoints }));
  const speeds = {};
  for (const name of [
    "hips",
    "leftLowerLeg",
    "rightLowerLeg",
    "leftFoot",
    "rightFoot",
    "leftToes",
    "rightToes",
  ]) {
    speeds[name] = {};
    for (const [label, values] of [
      ["source", source],
      ["adapted", samples],
    ]) {
      const velocity = values
        .slice(1)
        .map(
          (frame, index) =>
            vector(frame.points[name]).distanceTo(vector(values[index].points[name])) /
            (frame.time - values[index].time),
        );
      speeds[name][label] = {
        p95MetresPerSec: percentile(velocity, 0.95),
        maxMetresPerSec: Math.max(0, ...velocity),
      };
    }
  }
  const kneeBendDegrees = Object.fromEntries(
    sides.map((side) => [
      side,
      Object.fromEntries(
        [
          ["source", source],
          ["adapted", samples],
        ].map(([label, values]) => {
          const angles = values.map(({ points }) => {
            const h = vector(points[`${side}UpperLeg`]);
            const k = vector(points[`${side}LowerLeg`]);
            const a = vector(points[`${side}Foot`]);
            return 180 - THREE.MathUtils.radToDeg(h.sub(k).angleTo(a.sub(k)));
          });
          return [label, { min: Math.min(...angles), max: Math.max(...angles) }];
        }),
      ),
    ]),
  );
  return {
    startSec: window.startSec,
    endSec: window.endSec,
    sampleCount: samples.length,
    hipMotion: hipMotionMetrics(source, samples),
    speeds,
    kneeBendDegrees,
  };
}
function worldRotations(rig) {
  return Object.fromEntries(
    ["hips", "leftFoot", "leftToes", "rightFoot", "rightToes"].map((name) => [
      name,
      rig.humanoid
        .getNormalizedBoneNode(name)
        .getWorldQuaternion(new THREE.Quaternion())
        .normalize(),
    ]),
  );
}
function angularVelocity(before, after, dt) {
  const difference = after.clone().multiply(before.clone().invert()).normalize();
  if (difference.w < 0) difference.set(-difference.x, -difference.y, -difference.z, -difference.w);
  const axis = new THREE.Vector3(difference.x, difference.y, difference.z),
    length = axis.length();
  return length > 1e-10
    ? axis.multiplyScalar((2 * Math.atan2(length, difference.w)) / (length * dt)).toArray()
    : [0, 0, 0];
}
async function adaptRecordedContacts({
  input,
  output,
  contacts,
  expectedSha256,
  boundaryCandidates = [],
  targetModel = modelPath,
  diagnostic = false,
  reviewedUnit = null,
}) {
  const resolvedOutput = await fs.realpath(output).catch((error) => {
    if (error.code === "ENOENT") return path.resolve(output);
    throw error;
  });
  if ([await fs.realpath(input), await fs.realpath(targetModel)].includes(resolvedOutput))
    throw new Error("The output must not overwrite a source asset or target model");
  const sourceBuffer = await fs.readFile(input),
    model = await fs.readFile(targetModel);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? ""))
    throw new Error("An exact source SHA256 is required");
  if (hash(sourceBuffer) !== expectedSha256)
    throw new Error("Source contact metadata hash mismatch");
  if (hash(model) !== "739a1515cffe09c17a535eb52a11f88640fc7728b86b9e4c74f00c353437b7cd")
    throw new Error("Target must be the reviewed Yori model");
  const policy = reviewedUnit == null ? null : reviewedUnits[reviewedUnit];
  if (reviewedUnit != null && (!policy || policy.sourceSha256 !== expectedSha256))
    throw new Error("Reviewed unit does not match this exact source");
  const bounds = {
    ...defaultBounds,
    ...(policy ? { localRotationDegrees: policy.localRotationDegrees } : {}),
  };
  const animation = await loadAnimation(sourceBuffer),
    rig = await createRig(model, true),
    evaluate = evaluator(rig, animation);
  const times = Float32Array.from({ length: Math.ceil(animation.duration * hz) + 1 }, (_, i) =>
    Math.min(i / hz, animation.duration),
  );
  const frames = [];
  for (const time of times) {
    evaluate(time);
    frames.push({ time, points: positions(rig), soles: rig.shoeMinima() });
  }
  if (frames.some((f) => sides.some((side) => !Number.isFinite(f.soles[side]))))
    throw new Error("Actual target shoe geometry is required");
  const episodes = validatedEpisodes(contacts, animation.duration, frames);
  for (const frame of frames) prepareFrame(frame, episodes);
  const baseReport = {
    input: { file: path.relative(root, input), sha256: hash(sourceBuffer) },
    target: { file: path.relative(root, targetModel), sha256: hash(model) },
    durationSec: animation.duration,
    sampleHz: hz,
    rampSec,
    minimumSupportSec,
    maximumSourceSupportExcursionMetres,
    bounds,
    defaultBounds,
    reviewedUnit: policy ? { id: reviewedUnit, ...policy } : null,
    allowedPlaybackWindows: policy
      ? policy.windows.map((window) => ({ ...window, feet: "both" }))
      : null,
    sourceContactInference:
      "Metadata from the unchanged source skeleton; geometric proxy, not authored contact labels or semantic boundaries.",
    episodes: Object.fromEntries(
      sides.map((side) => [
        side,
        episodes[side].map(({ anchor, ...e }) => ({ ...e, targetAnchorCenter: anchor.toArray() })),
      ]),
    ),
    fullySupportedBothWindows: safeBothWindows(episodes),
    initialTargetPoints: frames[0].points,
  };
  if (
    policy &&
    !policy.windows.every((unit) =>
      baseReport.fullySupportedBothWindows.some(
        (window) => window.startSec <= unit.startSec && window.endSec >= unit.endSec,
      ),
    )
  )
    throw new Error("Reviewed playback window is outside verified double support");
  let padding = 0;
  while (!frames.every((f) => isReachable(f, padding)) && padding < bounds.reachPaddingMetres)
    padding += 0.00025;
  if (!frames.every((f) => isReachable(f, padding)))
    return {
      ...baseReport,
      accepted: false,
      reason: "Small root padding cannot reach the support targets",
      rootReachPaddingMetres: padding,
    };
  const adaptedRig = await createRig(model, true),
    adaptedEvaluate = evaluator(adaptedRig, animation, true),
    inverseScene = adaptedRig.scene.matrixWorld.clone().invert();
  const scale =
    adaptedRig.humanoid.normalizedRestPose.hips.position[1] / animation.restHipsPosition.y;
  const hipValues = new Float32Array(times.length * 3),
    rotations = new Map(changedBones.map((name) => [name, new Float32Array(times.length * 4)]));
  const counters = {
    maxRootCorrectionMetres: 0,
    maxReachProjectionMetres: 0,
    maxIndependentAnkleCorrectionMetres: 0,
    maxAnkleSolveErrorMetres: 0,
    minimumAuthoredPoleAgreement: 1,
    maxLocalRotationChangesDegrees: Object.fromEntries(changedBones.map((name) => [name, 0])),
    maxUnsupportedLocalRotationChangeDegrees: 0,
  };
  const priorQ = new Map();
  for (let i = 0; i < times.length; i++) {
    const frame = frames[i];
    adaptedEvaluate(frame.time);
    const original = new Map(
      changedBones.map((name) => [
        name,
        adaptedRig.humanoid.getNormalizedBoneNode(name).quaternion.clone().normalize(),
      ]),
    );
    const footWorld = Object.fromEntries(
      sides.map((side) => [
        side,
        adaptedRig.humanoid
          .getNormalizedBoneNode(`${side}Foot`)
          .getWorldQuaternion(new THREE.Quaternion()),
      ]),
    );
    const { delta, targets, reachAdjustment } = frameTargets(frame, padding);
    counters.maxReachProjectionMetres = Math.max(
      counters.maxReachProjectionMetres,
      reachAdjustment.length(),
    );
    if (delta.length() > counters.maxRootCorrectionMetres) {
      counters.maxRootCorrectionMetres = delta.length();
      counters.worstRootCorrection = {
        timeSec: frame.time,
        delta: delta.toArray(),
        weights: sides.map((side) => frame.support[side].weight),
      };
    }
    const hip = adaptedRig.humanoid.getNormalizedBoneNode("hips");
    hip.position.copy(
      hip.getWorldPosition(new THREE.Vector3()).add(delta).applyMatrix4(inverseScene),
    );
    hip.updateWorldMatrix(false, true);
    for (const side of sides)
      if (frame.support[side].weight > 0) {
        counters.maxIndependentAnkleCorrectionMetres = Math.max(
          counters.maxIndependentAnkleCorrectionMetres,
          targets[side].distanceTo(vector(frame.points[`${side}Foot`]).add(delta)),
        );
        solveLeg(adaptedRig, side, targets[side], footWorld[side], counters);
      }
    const p = hip.position.clone().multiplyScalar(1 / scale);
    p.x *= -1;
    p.z *= -1;
    p.toArray(hipValues, i * 3);
    for (const name of changedBones) {
      const q = adaptedRig.humanoid.getNormalizedBoneNode(name).quaternion.clone().normalize();
      const error = angleDegrees(q, original.get(name));
      if (error > counters.maxLocalRotationChangesDegrees[name]) {
        counters.maxLocalRotationChangesDegrees[name] = error;
        counters.worstLocalRotationAtSec ??= {};
        counters.worstLocalRotationAtSec[name] = frame.time;
      }
      const side = name.startsWith("left") ? "left" : "right";
      if (frame.support[side].weight === 0)
        counters.maxUnsupportedLocalRotationChangeDegrees = Math.max(
          counters.maxUnsupportedLocalRotationChangeDegrees,
          error,
        );
      q.x *= -1;
      q.z *= -1;
      if (priorQ.has(name) && q.dot(priorQ.get(name)) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      priorQ.set(name, q.clone());
      q.toArray(rotations.get(name), i * 4);
    }
  }
  const report = { ...baseReport, rootReachPaddingMetres: padding, corrections: counters };
  const budgetExceeded =
    counters.maxReachProjectionMetres > bounds.reachProjectionMetres ||
    counters.maxRootCorrectionMetres > bounds.rootCorrectionMetres ||
    counters.maxIndependentAnkleCorrectionMetres > bounds.independentAnkleMetres ||
    Object.values(counters.maxLocalRotationChangesDegrees).some(
      (v) => v > bounds.localRotationDegrees,
    );
  if (budgetExceeded && !diagnostic)
    return {
      ...report,
      accepted: false,
      reason: "Correction budget exceeded; no adapted asset written",
    };
  const metadata = {
    target: "Yori",
    modelSha256: hash(model),
    sourceFaithfulSha256: hash(sourceBuffer),
    sampleHz: hz,
    rampSec,
    contacts: baseReport.episodes,
    fullySupportedBothWindows: baseReport.fullySupportedBothWindows,
    allowedPlaybackWindows: baseReport.allowedPlaybackWindows,
    reviewedUnit: baseReport.reviewedUnit,
    loop: false,
    method:
      "Source hips XYZ plus bounded support translation and authored-pole leg IK only during long inferred support episodes. Unsupported leg rotations and all upper-body/finger tracks preserved.",
  };
  const binary = encode(sourceBuffer, times, hipValues, rotations, metadata),
    adapted = await loadAnimation(binary);
  const verifyRig = await createRig(model, true),
    verify = evaluator(verifyRig, adapted),
    sourceRig = await createRig(model, true),
    verifySource = evaluator(sourceRig, animation);
  const validation = {
    sampleHz: 120,
    evaluatedFrames: 0,
    fullSupportFootSamples: 0,
    maxSoleClearanceMetres: 0,
    maxSolePenetrationMetres: 0,
    maxContactCenterErrorMetres: 0,
    maxWorldFootRotationChangeDegrees: 0,
    maxUnsupportedLegRotationChangeDegrees: 0,
    minimumKneeBendDegrees: 180,
    minimumAdjacentPoleDot: 1,
    upperBodyAndFingerTracksExactlyPreserved: preservedOtherTracks(animation, adapted),
    allValuesFinite: createVRMAnimationClip(adapted, verifyRig).tracks.every((track) =>
      track.values.every(Number.isFinite),
    ),
    maxHipVelocityChangeMetresPerSec: 0,
    maxAdaptedHipSpeedMetresPerSec: 0,
  };
  const verificationFrames = [],
    priorPoles = new Map();
  let previous;
  for (let i = 0; i <= Math.ceil(animation.duration * 120); i++) {
    const time = Math.min(i / 120, animation.duration);
    verify(time);
    verifySource(time);
    validation.evaluatedFrames++;
    const frame = { time, points: positions(verifyRig) },
      sourcePoints = positions(sourceRig);
    frame.sourcePoints = sourcePoints;
    verificationFrames.push(frame);
    const soles = verifyRig.shoeMinima();
    for (const side of sides) {
      const support = supportAt(episodes[side], time),
        foot = verifyRig.humanoid.getNormalizedBoneNode(`${side}Foot`),
        originalFoot = sourceRig.humanoid.getNormalizedBoneNode(`${side}Foot`);
      validation.maxWorldFootRotationChangeDegrees = Math.max(
        validation.maxWorldFootRotationChangeDegrees,
        angleDegrees(
          foot.getWorldQuaternion(new THREE.Quaternion()).normalize(),
          originalFoot.getWorldQuaternion(new THREE.Quaternion()).normalize(),
        ),
      );
      if (support.weight >= 0.99999) {
        validation.fullSupportFootSamples++;
        validation.maxSoleClearanceMetres = Math.max(
          validation.maxSoleClearanceMetres,
          soles[side],
        );
        validation.maxSolePenetrationMetres = Math.max(
          validation.maxSolePenetrationMetres,
          -soles[side],
        );
        const center = vector(frame.points[`${side}Foot`])
            .add(vector(frame.points[`${side}Toes`]))
            .multiplyScalar(0.5),
          anchor = support.episode.anchor;
        validation.maxContactCenterErrorMetres = Math.max(
          validation.maxContactCenterErrorMetres,
          Math.hypot(center.x - anchor.x, center.z - anchor.z),
        );
      }
      if (support.weight === 0)
        for (const part of ["UpperLeg", "LowerLeg", "Foot"])
          validation.maxUnsupportedLegRotationChangeDegrees = Math.max(
            validation.maxUnsupportedLegRotationChangeDegrees,
            angleDegrees(
              verifyRig.humanoid
                .getNormalizedBoneNode(side + part)
                .quaternion.clone()
                .normalize(),
              sourceRig.humanoid
                .getNormalizedBoneNode(side + part)
                .quaternion.clone()
                .normalize(),
            ),
          );
      const h = vector(frame.points[`${side}UpperLeg`]),
        k = vector(frame.points[`${side}LowerLeg`]),
        a = vector(frame.points[`${side}Foot`]),
        pole = k.clone().sub(h).cross(a.clone().sub(h)).normalize();
      const bend =
        180 -
        angleDegrees(
          new THREE.Quaternion().setFromUnitVectors(
            h.clone().sub(k).normalize(),
            a.clone().sub(k).normalize(),
          ),
          new THREE.Quaternion(),
        );
      validation.minimumKneeBendDegrees = Math.min(validation.minimumKneeBendDegrees, bend);
      if (priorPoles.has(side) && support.weight > 0)
        validation.minimumAdjacentPoleDot = Math.min(
          validation.minimumAdjacentPoleDot,
          pole.dot(priorPoles.get(side)),
        );
      priorPoles.set(side, pole);
    }
    if (previous) {
      const dt = time - previous.time;
      if (dt > 1e-7) {
        const a = vector(frame.points.hips).sub(vector(previous.points.hips)).divideScalar(dt),
          b = vector(sourcePoints.hips).sub(vector(previous.source.hips)).divideScalar(dt);
        validation.maxHipVelocityChangeMetresPerSec = Math.max(
          validation.maxHipVelocityChangeMetresPerSec,
          a.distanceTo(b),
        );
        validation.maxAdaptedHipSpeedMetresPerSec = Math.max(
          validation.maxAdaptedHipSpeedMetresPerSec,
          a.length(),
        );
      }
    }
    previous = { ...frame, source: sourcePoints };
  }
  const sourceForMetrics = [];
  for (const frame of frames) sourceForMetrics.push(frame);
  const adaptedAt60 = frames.map((frame) => {
    verify(frame.time);
    return { time: frame.time, points: positions(verifyRig) };
  });
  const boundaryTimes = [
    ...new Set([
      0,
      animation.duration,
      ...boundaryCandidates.map((c) => c.timeSec),
      ...(policy ? policy.windows.flatMap((window) => [window.startSec, window.endSec]) : []),
      ...baseReport.fullySupportedBothWindows.flatMap((w) => [w.startSec, w.endSec]),
    ]),
  ].filter((t) => t >= 0 && t <= animation.duration);
  const boundaries = [];
  for (const timeSec of boundaryTimes) {
    const dt = 1 / 120,
      t0 = Math.max(0, timeSec - dt),
      t1 = Math.min(animation.duration, timeSec + dt);
    verify(t0);
    const p0 = positions(verifyRig);
    const q0 = worldRotations(verifyRig);
    verify(t1);
    const p1 = positions(verifyRig);
    const q1 = worldRotations(verifyRig);
    verify(timeSec);
    const points = positions(verifyRig);
    boundaries.push({
      timeSec,
      fullySupportedBoth: sides.every(
        (side) => supportAt(episodes[side], timeSec).weight >= 0.99999,
      ),
      joints: Object.fromEntries(
        ["hips", "leftFoot", "leftToes", "rightFoot", "rightToes"].map((name) => [
          name,
          {
            position: points[name],
            localRotation: verifyRig.humanoid.getNormalizedBoneNode(name).quaternion.toArray(),
            worldRotation: verifyRig.humanoid
              .getNormalizedBoneNode(name)
              .getWorldQuaternion(new THREE.Quaternion())
              .toArray(),
            linearVelocity: vector(p1[name])
              .sub(vector(p0[name]))
              .divideScalar(t1 - t0)
              .toArray(),
            angularVelocity: angularVelocity(q0[name], q1[name], t1 - t0),
          },
        ]),
      ),
    });
  }
  const numericalValidated =
    baseReport.fullySupportedBothWindows.length > 0 &&
    validation.upperBodyAndFingerTracksExactlyPreserved &&
    validation.allValuesFinite &&
    validation.fullSupportFootSamples > 0 &&
    validation.maxSoleClearanceMetres <= bounds.soleErrorMetres &&
    validation.maxSolePenetrationMetres <= bounds.soleErrorMetres &&
    validation.maxContactCenterErrorMetres <= bounds.contactCenterErrorMetres &&
    validation.maxWorldFootRotationChangeDegrees <= bounds.footWorldRotationDegrees &&
    validation.maxUnsupportedLegRotationChangeDegrees < 0.005 &&
    validation.minimumAdjacentPoleDot > 0.99;
  const accepted = numericalValidated && !budgetExceeded;
  const writeDiagnostic =
    diagnostic && validation.upperBodyAndFingerTracksExactlyPreserved && validation.allValuesFinite;
  const result = {
    ...report,
    accepted,
    numericalValidated,
    budgetExceeded,
    diagnostic,
    reason: accepted
      ? "Numerical target-support checks passed; visual review and cross-clip compatibility remain separate"
      : writeDiagnostic
        ? "Diagnostic asset written for visual review; initial budget or validation flags remain"
        : baseReport.fullySupportedBothWindows.length === 0
          ? "No validated double-support window; no automatic full-body asset"
          : "Validation failed; no adapted asset written",
    validation,
    hipMotion: hipMotionMetrics(sourceForMetrics, adaptedAt60),
    supportWindowMotion: baseReport.fullySupportedBothWindows.map((window) =>
      trajectoryWindowMetrics(verificationFrames, window),
    ),
    reviewedUnitMotions: policy
      ? policy.windows.map((window) => ({
          id: window.id,
          ...trajectoryWindowMetrics(verificationFrames, window),
        }))
      : [],
    boundaries,
    output:
      accepted || writeDiagnostic
        ? { file: path.relative(root, output), sha256: hash(binary), bytes: binary.length }
        : null,
    limitations: [
      "Contact intervals are inferred from source speed/height, not ground-truth labels.",
      "Short support episodes are left unchanged. Unsupported legs retain source-local motion; common hips correction can translate their world trajectory by the bounded root delta.",
      "Foot world orientation is preserved: remaining toe/heel rocking is intentional source motion, not a flat-foot guarantee.",
      "Finite full-body asset only. No looping, semantic boundary, animation transition, or automatic catalog approval is implied.",
    ],
  };
  if (accepted || writeDiagnostic) {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, binary);
  }
  return result;
}

export { adaptRecordedContacts };

async function main() {
  const contactFile = path.resolve(
    process.argv[2] ?? path.join(root, "docs/decisions/recorded-contact-candidates.json"),
  );
  const selected = [];
  let diagnostic = false;
  let reviewedUnit = null;
  for (let index = 3; index < process.argv.length; index++) {
    const argument = process.argv[index];
    if (argument === "--diagnostic") diagnostic = true;
    else if (argument === "--reviewed-unit") {
      reviewedUnit = process.argv[++index];
      if (!Object.hasOwn(reviewedUnits, reviewedUnit ?? ""))
        throw new Error("Unknown reviewed unit");
    } else if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    else selected.push(argument);
  }
  if (reviewedUnit && selected.length !== 1)
    throw new Error("A reviewed-unit run must select exactly one clip");
  const report = JSON.parse(await fs.readFile(contactFile, "utf8"));
  if (!selected.length) throw new Error("Select at least one source clip explicitly");
  const names = new Set(
    report.recordings.map((recording) => path.basename(recording.file, ".vrma")),
  );
  if (selected.some((name) => !names.has(name)))
    throw new Error("A selected clip is absent from the source contact report");
  const results = [];
  for (const recording of report.recordings) {
    const name = path.basename(recording.file, ".vrma");
    if (selected.length && !selected.includes(name)) continue;
    const input = path.isAbsolute(recording.file)
      ? recording.file
      : path.resolve(
          root,
          path.basename(recording.file) === recording.file
            ? ".motion-review/source-assets/prepared"
            : "",
          recording.file,
        );
    const output = path.join(
      root,
      ".motion-review/source-assets/prepared",
      `${name}.yori-contact${diagnostic ? ".diagnostic" : ""}.vrma`,
    );
    try {
      results.push(
        await adaptRecordedContacts({
          input,
          output,
          contacts: recording.contacts,
          expectedSha256: recording.sha256,
          boundaryCandidates: recording.boundaryCandidates,
          diagnostic,
          reviewedUnit,
        }),
      );
    } catch (error) {
      results.push({ input: recording.file, accepted: false, reason: String(error) });
    }
    console.log(JSON.stringify(results.at(-1)));
  }
  if (!results.length) throw new Error("No matching source recording");
  const destination = path.join(root, ".motion-review/recorded-contact-adaptation-results.json");
  await fs.writeFile(
    destination,
    `${JSON.stringify(
      { schemaVersion: 1, contactReport: path.relative(root, contactFile), results },
      null,
      2,
    )}\n`,
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();

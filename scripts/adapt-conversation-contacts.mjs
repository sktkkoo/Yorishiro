#!/usr/bin/env node
/** Private, Yori-specific contact adaptation; source-faithful input stays immutable.
 * node scripts/adapt-conversation-contacts.mjs
 * Provisional support interval only; this is not general-purpose dance IK.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createVRMAnimationClip } from "@pixiv/three-vrm-animation";
import * as THREE from "three";
import { createRig, glbParts, loadAnimation } from "./measure-conversation-retarget.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const input = path.join(root, ".motion-review/source-assets/prepared/Idle Conversation.vrma");
const modelPath = path.join(root, "public/models/Yori.vrm");
const output = path.join(
  root,
  ".motion-review/source-assets/prepared/Idle Conversation.yori-contact.vrma",
);
const reportPath = path.join(root, "docs/decisions/conversation-contact-adaptation-metrics.json");
const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
const hz = 60,
  start = 0.15,
  end = 25,
  ramp = 0.35;
const sides = ["left", "right"],
  footNames = sides.flatMap((side) => [`${side}Foot`, `${side}Toes`]);
const changedBones = sides.flatMap((side) => [`${side}UpperLeg`, `${side}LowerLeg`, `${side}Foot`]);
const vector = (values) => new THREE.Vector3().fromArray(values);
const ease = (value) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * t * (10 + t * (-15 + 6 * t));
};
const strength = (time) => ease((time - start) / ramp) * ease((end - time) / ramp);

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
function rootCorrection(frame, anchors) {
  const desired = {};
  for (const side of sides) {
    const center = vector(frame.points[`${side}Foot`])
      .add(vector(frame.points[`${side}Toes`]))
      .multiplyScalar(0.5);
    desired[side] = new THREE.Vector3(
      anchors[side].x - center.x,
      -frame.soles[side],
      anchors[side].z - center.z,
    );
  }
  return { desired, common: desired.left.clone().add(desired.right).multiplyScalar(0.5) };
}
function reachable(frame, padding) {
  const weight = strength(frame.time);
  for (const side of sides) {
    const h = vector(frame.points[`${side}UpperLeg`]),
      k = vector(frame.points[`${side}LowerLeg`]),
      a = vector(frame.points[`${side}Foot`]);
    const length = h.distanceTo(k) + k.distanceTo(a) - 0.00002;
    const target = a.addScaledVector(frame.desired[side], weight);
    h.addScaledVector(frame.common, weight);
    h.y -= padding * weight;
    if (weight > 0 && h.distanceTo(target) > length) return false;
  }
  return true;
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
  animation.name = "Yori contact-adapted Conversation";
  json.asset.generator = "Yorishiro bounded target contact adaptation";
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

const sourceBuffer = await fs.readFile(input),
  model = await fs.readFile(modelPath),
  animation = await loadAnimation(sourceBuffer);
if (
  hash(sourceBuffer) !== "0376d3e416975f7d25aadd817828b77cf53a2f84ec5bc3cc3053fe1bc631dcf1" ||
  hash(model) !== "739a1515cffe09c17a535eb52a11f88640fc7728b86b9e4c74f00c353437b7cd"
)
  throw new Error(
    "This contact adaptation is restricted to the reviewed Conversation and Yori hashes",
  );
const rig = await createRig(model, true),
  evaluate = evaluator(rig, animation);
const times = Float32Array.from({ length: Math.ceil(animation.duration * hz) + 1 }, (_, i) =>
  Math.min(i / hz, animation.duration),
);
const frames = [];
for (const time of times) {
  evaluate(time);
  frames.push({ time, points: positions(rig), soles: rig.shoeMinima() });
}
const anchorFrame = frames[Math.round(start * hz)],
  anchors = Object.fromEntries(
    sides.map((side) => [
      side,
      vector(anchorFrame.points[`${side}Foot`])
        .add(vector(anchorFrame.points[`${side}Toes`]))
        .multiplyScalar(0.5),
    ]),
  );
for (const frame of frames) Object.assign(frame, rootCorrection(frame, anchors));
let padding = 0;
while (!frames.every((frame) => reachable(frame, padding)) && padding < 0.005) padding += 0.00025;
if (!frames.every((frame) => reachable(frame, padding)))
  throw new Error("Small root reach padding cannot keep both legs reachable");
const hipsOnly = {
  maxRootCorrectionMetres: 0,
  maxHorizontalPointResidualMetres: 0,
  maxSoleClearanceMetres: 0,
  maxPenetrationMetres: 0,
};
for (const frame of frames.filter((frame) => strength(frame.time) > 0.9999)) {
  const delta = frame.common.clone();
  delta.y = -Math.min(frame.soles.left, frame.soles.right);
  hipsOnly.maxRootCorrectionMetres = Math.max(hipsOnly.maxRootCorrectionMetres, delta.length());
  for (const side of sides)
    hipsOnly.maxSoleClearanceMetres = Math.max(
      hipsOnly.maxSoleClearanceMetres,
      frame.soles[side] + delta.y,
    );
  for (const name of footNames)
    hipsOnly.maxHorizontalPointResidualMetres = Math.max(
      hipsOnly.maxHorizontalPointResidualMetres,
      Math.hypot(
        frame.points[name][0] + delta.x - anchorFrame.points[name][0],
        frame.points[name][2] + delta.z - anchorFrame.points[name][2],
      ),
    );
}

const adaptedRig = await createRig(model, true),
  adaptedEvaluate = evaluator(adaptedRig, animation, true),
  inverseScene = adaptedRig.scene.matrixWorld.clone().invert();
const scale =
  adaptedRig.humanoid.normalizedRestPose.hips.position[1] / animation.restHipsPosition.y;
const hipValues = new Float32Array(times.length * 3),
  rotations = new Map(changedBones.map((name) => [name, new Float32Array(times.length * 4)]));
const counters = {
  maxRootCorrectionMetres: 0,
  maxIndependentAnkleCorrectionMetres: 0,
  maxAnkleSolveErrorMetres: 0,
  minimumAuthoredPoleAgreement: 1,
  maxWorldFootRotationChangeDegrees: 0,
  maxLocalRotationChangesDegrees: Object.fromEntries(changedBones.map((name) => [name, 0])),
};
for (let i = 0; i < times.length; i++) {
  const frame = frames[i],
    weight = strength(frame.time);
  adaptedEvaluate(frame.time);
  const originalRotations = new Map(
    changedBones.map((name) => [
      name,
      adaptedRig.humanoid.getNormalizedBoneNode(name).quaternion.clone(),
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
  const delta = frame.common.clone();
  delta.y -= padding;
  delta.multiplyScalar(weight);
  counters.maxRootCorrectionMetres = Math.max(counters.maxRootCorrectionMetres, delta.length());
  const hip = adaptedRig.humanoid.getNormalizedBoneNode("hips"),
    worldHip = hip.getWorldPosition(new THREE.Vector3()).add(delta);
  hip.position.copy(worldHip.applyMatrix4(inverseScene));
  hip.updateWorldMatrix(false, true);
  if (weight > 0)
    for (const side of sides) {
      const desired = vector(frame.points[`${side}Foot`]).addScaledVector(
        frame.desired[side],
        weight,
      );
      const commonOnly = vector(frame.points[`${side}Foot`]).add(delta);
      counters.maxIndependentAnkleCorrectionMetres = Math.max(
        counters.maxIndependentAnkleCorrectionMetres,
        desired.distanceTo(commonOnly),
      );
      solveLeg(adaptedRig, side, desired, footWorld[side], counters);
    }
  adaptedRig.humanoid.update();
  adaptedRig.scene.updateMatrixWorld(true);
  const sourceHip = hip.position.clone().multiplyScalar(1 / scale);
  sourceHip.x *= -1;
  sourceHip.z *= -1;
  sourceHip.toArray(hipValues, i * 3);
  for (const name of changedBones) {
    const q = adaptedRig.humanoid.getNormalizedBoneNode(name).quaternion.clone().normalize();
    counters.maxLocalRotationChangesDegrees[name] = Math.max(
      counters.maxLocalRotationChangesDegrees[name],
      THREE.MathUtils.radToDeg(q.angleTo(originalRotations.get(name).normalize())),
    );
    q.x *= -1;
    q.z *= -1;
    q.toArray(rotations.get(name), i * 4);
  }
  for (const side of sides)
    counters.maxWorldFootRotationChangeDegrees = Math.max(
      counters.maxWorldFootRotationChangeDegrees,
      THREE.MathUtils.radToDeg(
        adaptedRig.humanoid
          .getNormalizedBoneNode(`${side}Foot`)
          .getWorldQuaternion(new THREE.Quaternion())
          .normalize()
          .angleTo(footWorld[side].normalize()),
      ),
    );
}
if (
  counters.maxRootCorrectionMetres > 0.025 ||
  counters.maxIndependentAnkleCorrectionMetres > 0.015 ||
  Object.values(counters.maxLocalRotationChangesDegrees).some((angle) => angle > 8)
)
  throw new Error(`Correction budget exceeded: ${JSON.stringify(counters)}`);
const metadata = {
  target: "Yori",
  modelSha256: hash(model),
  sourceFaithfulSha256: hash(sourceBuffer),
  supportStartSec: start,
  supportEndSec: end,
  rampSec: ramp,
  sampleHz: hz,
  method:
    "small common hips translation + authored-pole two-bone legs; preserve foot world orientation; unchanged upper body and fingers",
};
const binary = encode(sourceBuffer, times, hipValues, rotations, metadata),
  adaptedAnimation = await loadAnimation(binary);
for (const [name, values] of rotations) {
  const loaded = adaptedAnimation.humanoidTracks.rotation.get(name);
  let max = 0;
  for (let k = 0; k < values.length; k++)
    max = Math.max(max, Math.abs(values[k] - loaded.values[k]));
  if (max > 1e-6)
    throw new Error(
      `Encoded rotation changed ${name}: ${max}, ${values.length} / ${loaded.values.length}`,
    );
}
const verifyRig = await createRig(model, true),
  verify = evaluator(verifyRig, adaptedAnimation);
const validation = {
  evaluatedFrameCount: 0,
  fullContactFrameCount: 0,
  maxSoleClearanceMetres: 0,
  maxSolePenetrationMetres: 0,
  maxHorizontalSupportPointDisplacementMetres: 0,
  maxContactCenterErrorMetres: 0,
  maxFootOrientationErrorDegrees: 0,
  upperBodyRotationTracksExactlyPreserved: true,
  allRetargetValuesFinite: true,
};
for (const [name, track] of animation.humanoidTracks.rotation)
  if (!changedBones.includes(name)) {
    const other = adaptedAnimation.humanoidTracks.rotation.get(name);
    if (
      !Buffer.from(track.values.buffer, track.values.byteOffset, track.values.byteLength).equals(
        Buffer.from(other.values.buffer, other.values.byteOffset, other.values.byteLength),
      ) ||
      !Buffer.from(track.times.buffer, track.times.byteOffset, track.times.byteLength).equals(
        Buffer.from(other.times.buffer, other.times.byteOffset, other.times.byteLength),
      )
    )
      validation.upperBodyRotationTracksExactlyPreserved = false;
  }
const verifySourceRig = await createRig(model, true),
  verifySource = evaluator(verifySourceRig, animation);
const kneeStability = {
  minimumKneeBendDegrees: 180,
  minimumAdjacentPoleDot: 1,
  maxSourceKneeSpeedMetresPerSec: 0,
  maxAdaptedKneeSpeedMetresPerSec: 0,
};
const priorKnees = new Map();
// Evaluate at 120 Hz as well as every exported key; avoid testing only the bake samples.
for (let i = 0; i <= Math.ceil(animation.duration * 120); i++) {
  const time = Math.min(i / 120, animation.duration);
  verify(time);
  verifySource(time);
  validation.evaluatedFrameCount++;
  const fullContact = strength(time) > 0.9999;
  for (const side of sides) {
    const foot = verifyRig.humanoid.getNormalizedBoneNode(`${side}Foot`),
      toe = verifyRig.humanoid.getNormalizedBoneNode(`${side}Toes`);
    const p = foot.getWorldPosition(new THREE.Vector3()),
      q = toe.getWorldPosition(new THREE.Vector3()),
      center = p.clone().add(q).multiplyScalar(0.5);
    const sourceQ = verifySourceRig.humanoid
      .getNormalizedBoneNode(`${side}Foot`)
      .getWorldQuaternion(new THREE.Quaternion())
      .normalize();
    const orientationError = THREE.MathUtils.radToDeg(
      foot.getWorldQuaternion(new THREE.Quaternion()).normalize().angleTo(sourceQ),
    );
    if (orientationError > validation.maxFootOrientationErrorDegrees) {
      validation.maxFootOrientationErrorDegrees = orientationError;
      validation.worstOrientationAtSec = time;
    }
    if (fullContact) {
      validation.maxContactCenterErrorMetres = Math.max(
        validation.maxContactCenterErrorMetres,
        Math.hypot(center.x - anchors[side].x, center.z - anchors[side].z),
      );
      for (const [name, position] of [
        [`${side}Foot`, p],
        [`${side}Toes`, q],
      ])
        validation.maxHorizontalSupportPointDisplacementMetres = Math.max(
          validation.maxHorizontalSupportPointDisplacementMetres,
          Math.hypot(
            position.x - anchorFrame.points[name][0],
            position.z - anchorFrame.points[name][2],
          ),
        );
    }
    if (strength(time) > 0) {
      const h = verifyRig.humanoid
        .getNormalizedBoneNode(`${side}UpperLeg`)
        .getWorldPosition(new THREE.Vector3());
      const knee = verifyRig.humanoid
        .getNormalizedBoneNode(`${side}LowerLeg`)
        .getWorldPosition(new THREE.Vector3());
      const sourceKnee = verifySourceRig.humanoid
        .getNormalizedBoneNode(`${side}LowerLeg`)
        .getWorldPosition(new THREE.Vector3());
      const pole = knee.clone().sub(h).cross(p.clone().sub(h)).normalize();
      const bend = 180 - THREE.MathUtils.radToDeg(h.clone().sub(knee).angleTo(p.clone().sub(knee)));
      kneeStability.minimumKneeBendDegrees = Math.min(kneeStability.minimumKneeBendDegrees, bend);
      const prior = priorKnees.get(side);
      if (prior) {
        kneeStability.minimumAdjacentPoleDot = Math.min(
          kneeStability.minimumAdjacentPoleDot,
          pole.dot(prior.pole),
        );
        kneeStability.maxSourceKneeSpeedMetresPerSec = Math.max(
          kneeStability.maxSourceKneeSpeedMetresPerSec,
          sourceKnee.distanceTo(prior.source) / (time - prior.time),
        );
        kneeStability.maxAdaptedKneeSpeedMetresPerSec = Math.max(
          kneeStability.maxAdaptedKneeSpeedMetresPerSec,
          knee.distanceTo(prior.knee) / (time - prior.time),
        );
      }
      priorKnees.set(side, { time, pole, knee, source: sourceKnee });
    }
  }
  if (fullContact) {
    validation.fullContactFrameCount++;
    for (const value of Object.values(verifyRig.shoeMinima())) {
      validation.maxSoleClearanceMetres = Math.max(validation.maxSoleClearanceMetres, value);
      validation.maxSolePenetrationMetres = Math.max(validation.maxSolePenetrationMetres, -value);
    }
  }
}
validation.allRetargetValuesFinite = createVRMAnimationClip(
  adaptedAnimation,
  verifyRig,
).tracks.every((track) => track.values.every(Number.isFinite));
if (kneeStability.minimumAdjacentPoleDot < 0.99 || kneeStability.minimumKneeBendDegrees < 0.1)
  throw new Error(`Unstable knee: ${JSON.stringify(kneeStability)}`);
if (
  !validation.upperBodyRotationTracksExactlyPreserved ||
  !validation.allRetargetValuesFinite ||
  validation.maxSoleClearanceMetres > 0.0005 ||
  validation.maxSolePenetrationMetres > 0.0005 ||
  validation.maxContactCenterErrorMetres > 0.0005 ||
  validation.maxHorizontalSupportPointDisplacementMetres > 0.004 ||
  validation.maxFootOrientationErrorDegrees > 0.05
)
  throw new Error(`Contact adaptation failed: ${JSON.stringify({ validation, counters })}`);
const hipRange = (track) =>
  [0, 1, 2].map((axis) => {
    const values = Array.from(track.values).filter((_value, index) => index % 3 === axis);
    return (Math.max(...values) - Math.min(...values)) * scale;
  });
const report = {
  schemaVersion: 1,
  input: { file: path.relative(root, input), sha256: hash(sourceBuffer) },
  model: { file: path.relative(root, modelPath), sha256: hash(model) },
  output: { file: path.relative(root, output), sha256: hash(binary), bytes: binary.length },
  metadata,
  rootReachPaddingMetres: padding,
  hipsOnly,
  corrections: counters,
  authoredTargetHipAxisRangesMetres: hipRange(animation.humanoidTracks.translation.get("hips")),
  adaptedTargetHipAxisRangesMetres: hipRange(
    adaptedAnimation.humanoidTracks.translation.get("hips"),
  ),
  kneeStability,
  validation,
  limitations: [
    "This is a Yori-specific target adaptation, not source-faithful roundtrip data or a general dance solver.",
    "Support labels are provisional source-derived quiet intervals. Entry/release ramps and remaining foot rocking require visual review.",
    "Original hips XYZ variation remains the baseline. Upper-body/finger tracks are byte-identical; feet retain authored world orientation, with small leg-local changes.",
    "No production catalog or original asset is replaced.",
  ],
};
await fs.writeFile(output, binary);
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

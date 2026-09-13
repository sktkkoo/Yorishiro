#!/usr/bin/env node
/** CPU-only, full-clip source / Yori retarget audit. Inputs are read-only.
 * node scripts/measure-conversation-retarget.mjs [report-json]
 * Measures bone trajectories plus actual skinned shoe vertices, without textures/rendering.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VRMHumanoid, VRMUtils } from "@pixiv/three-vrm";
import { createVRMAnimationClip, VRMAnimationLoaderPlugin } from "@pixiv/three-vrm-animation";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = {
  model: path.join(root, "public/models/Yori.vrm"),
  current: path.join(root, "public/animations/Idle Conversation.vrma"),
  faithful: path.join(root, ".motion-review/source-assets/prepared/Idle Conversation.vrma"),
};
const sampleHz = 60;
const names = ["hips", "leftFoot", "leftToes", "rightFoot", "rightToes"];
const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
const arrayBuffer = (buffer) =>
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
const round = (value) => Math.round(value * 1e8) / 1e8;
const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];

function glbParts(buffer) {
  const chunks = [];
  for (let offset = 12; offset < buffer.length; ) {
    const length = buffer.readUInt32LE(offset),
      type = buffer.readUInt32LE(offset + 4);
    chunks.push({ type, buffer: buffer.subarray(offset + 8, offset + 8 + length) });
    offset += 8 + length;
  }
  return {
    json: JSON.parse(chunks.find((chunk) => chunk.type === 0x4e4f534a).buffer.toString()),
    bin: chunks.find((chunk) => chunk.type === 0x004e4942).buffer,
  };
}
function textureFreeModel(buffer) {
  const { json, bin } = glbParts(buffer);
  // In-memory omission only: geometry, skin, rest nodes and inverse binds stay exact.
  for (const mesh of json.meshes)
    for (const primitive of mesh.primitives) delete primitive.material;
  delete json.images;
  delete json.textures;
  delete json.materials;
  const raw = Buffer.from(JSON.stringify(json)),
    padded = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 0x20);
  raw.copy(padded);
  const header = Buffer.alloc(20),
    binHeader = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + padded.length + bin.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return { json, buffer: Buffer.concat([header, padded, binHeader, bin]) };
}
async function createRig(buffer, model) {
  const input = model ? textureFreeModel(buffer) : { json: glbParts(buffer).json, buffer };
  const gltf = await new GLTFLoader().parseAsync(arrayBuffer(input.buffer), "");
  const legacy = input.json.extensions.VRM;
  const definitions = legacy
    ? legacy.humanoid.humanBones.map(({ bone, node }) => [
        bone
          .replace(/ThumbProximal$/, "ThumbMetacarpal")
          .replace(/ThumbIntermediate$/, "ThumbProximal"),
        node,
      ])
    : Object.entries(input.json.extensions.VRMC_vrm_animation.humanoid.humanBones).map(
        ([name, value]) => [name, value.node],
      );
  const humanBones = Object.fromEntries(
    await Promise.all(
      definitions.map(async ([name, index]) => [
        name,
        { node: await gltf.parser.getDependency("node", index) },
      ]),
    ),
  );
  const humanoid = new VRMHumanoid(humanBones),
    scene = gltf.scene;
  scene.add(humanoid.normalizedHumanBonesRoot);
  const rig = { scene, humanoid, meta: { metaVersion: legacy ? "0" : "1" } };
  VRMUtils.rotateVRM0(rig);
  scene.updateMatrixWorld(true);
  const rest = Object.fromEntries(
    names.map((name) => [
      name,
      humanoid.getNormalizedBoneNode(name).getWorldPosition(new THREE.Vector3()).toArray(),
    ]),
  );
  const shoeVertices = { left: [], right: [] },
    p = new THREE.Vector3();
  scene.traverse((mesh) => {
    if (!mesh.isSkinnedMesh) return;
    const indices = mesh.geometry.attributes.skinIndex,
      weights = mesh.geometry.attributes.skinWeight;
    for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
      mesh.getVertexPosition(i, p).applyMatrix4(mesh.matrixWorld);
      if (p.y > 0.15) continue;
      for (const side of ["left", "right"]) {
        let influence = 0;
        for (let slot = 0; slot < 4; slot++) {
          const bone = mesh.skeleton.bones[indices.getComponent(i, slot)];
          if (
            bone === humanoid.getRawBoneNode(`${side}Foot`) ||
            bone === humanoid.getRawBoneNode(`${side}Toes`)
          )
            influence += weights.getComponent(i, slot);
        }
        if (influence >= 0.5) shoeVertices[side].push({ mesh, index: i });
      }
    }
  });
  const shoeMinima = () =>
    Object.fromEntries(
      Object.entries(shoeVertices).map(([side, vertices]) => [
        side,
        vertices.length
          ? Math.min(
              ...vertices.map(
                ({ mesh, index }) =>
                  mesh.getVertexPosition(index, p).applyMatrix4(mesh.matrixWorld).y,
              ),
            )
          : null,
      ]),
    );
  return { ...rig, rest, shoeVertices, shoeMinima, restShoeMinima: shoeMinima() };
}
async function loadAnimation(buffer) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  return (await loader.parseAsync(arrayBuffer(buffer), "")).userData.vrmAnimations[0];
}
function sample(rig, animation, duration) {
  const clip = createVRMAnimationClip(animation, rig);
  if (!clip.tracks.every((track) => track.values.every(Number.isFinite)))
    throw new Error("Non-finite retarget result");
  const mixer = new THREE.AnimationMixer(rig.scene),
    action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const frames = [],
    p = new THREE.Vector3(),
    raw = new THREE.Vector3();
  let maxRawNormalizedDifference = 0;
  const frameCount = Math.ceil(duration * sampleHz) + 1;
  for (let frame = 0; frame < frameCount; frame++) {
    const time = Math.min(frame / sampleHz, duration);
    mixer.setTime(time);
    rig.humanoid.update();
    rig.scene.updateMatrixWorld(true);
    const positions = {};
    for (const name of names) {
      rig.humanoid.getNormalizedBoneNode(name).getWorldPosition(p);
      rig.humanoid.getRawBoneNode(name).getWorldPosition(raw);
      maxRawNormalizedDifference = Math.max(maxRawNormalizedDifference, p.distanceTo(raw));
      positions[name] = p.toArray();
    }
    frames.push({ time, positions, soles: rig.shoeMinima() });
  }
  return {
    rig,
    frames,
    rest: rig.rest,
    restShoeMinima: rig.restShoeMinima,
    maxRawNormalizedDifference,
  };
}
const distance = (a, b, horizontal = false) =>
  Math.hypot(a[0] - b[0], horizontal ? 0 : a[1] - b[1], a[2] - b[2]);
function summarize(lane) {
  const trajectories = {};
  for (const name of names) {
    const points = lane.frames.map((frame) => frame.positions[name]),
      speeds = [];
    for (let i = 1; i < points.length; i++)
      speeds.push(
        distance(points[i], points[i - 1]) / (lane.frames[i].time - lane.frames[i - 1].time),
      );
    trajectories[name] = {
      initialWorldPositionMetres: points[0],
      initialDisplacementFromRestMetres: distance(points[0], lane.rest[name]),
      rangeMetres: [0, 1, 2].map(
        (axis) => Math.max(...points.map((p) => p[axis])) - Math.min(...points.map((p) => p[axis])),
      ),
      minWorldYMetres: Math.min(...points.map((p) => p[1])),
      maxHorizontalDisplacementFromStartMetres: Math.max(
        ...points.map((p) => distance(p, points[0], true)),
      ),
      speedP95MetresPerSec: percentile(speeds, 0.95),
      maxSpeedMetresPerSec: Math.max(...speeds),
    };
  }
  return {
    frameCount: lane.frames.length,
    restWorldPositionsMetres: lane.rest,
    referenceSegmentLengthsMetres: Object.fromEntries(
      ["left", "right"].flatMap((side) =>
        ["LowerLeg", "Foot", "Toes"].map((part) => [
          `${side}${part}`,
          lane.rig.humanoid.normalizedRestPose[`${side}${part}`].position.reduce(
            (sum, value) => sum + value * value,
            0,
          ) ** 0.5,
        ]),
      ),
    ),
    maxRawNormalizedDifferenceMetres: lane.maxRawNormalizedDifference,
    trajectories,
    shoes: Object.fromEntries(
      ["left", "right"].map((side) => {
        const heights = lane.frames
          .map((frame) => frame.soles[side])
          .filter((value) => value !== null);
        return [
          side,
          heights.length
            ? {
                measuredVertexCount: lane.rig.shoeVertices[side].length,
                restMinimumYMetres: lane.restShoeMinima[side],
                minMinimumYMetres: Math.min(...heights),
                maxMinimumYMetres: Math.max(...heights),
                maxBelowRestFloorMetres: Math.max(
                  0,
                  lane.restShoeMinima[side] - Math.min(...heights),
                ),
                maxAboveRestFloorMetres: Math.max(
                  0,
                  Math.max(...heights) - lane.restShoeMinima[side],
                ),
              }
            : null,
        ];
      }),
    ),
  };
}
function contactEpisodes(source, lanes) {
  const episodes = [];
  for (const side of ["left", "right"]) {
    const foot = `${side}Foot`,
      toe = `${side}Toes`,
      frames = source.frames;
    const minY = Math.min(...frames.map((frame) => frame.positions[toe][1]));
    let start = null;
    for (let i = 1; i <= frames.length; i++) {
      const dt = i < frames.length ? frames[i].time - frames[i - 1].time : 1;
      const quiet =
        i < frames.length &&
        frames[i].positions[toe][1] <= minY + 0.015 &&
        [foot, toe].every(
          (name) => distance(frames[i].positions[name], frames[i - 1].positions[name]) / dt < 0.04,
        );
      if (quiet && start === null) start = i;
      if (!quiet && start !== null) {
        const end = i - 1;
        if (frames[end].time - frames[start].time >= 0.4) {
          const metrics = {};
          for (const [key, lane] of Object.entries(lanes)) {
            const values = lane.frames.slice(start, end + 1),
              first = values[0];
            metrics[key] = {
              maxFootHorizontalDisplacementMetres: Math.max(
                ...values.flatMap((frame) =>
                  [foot, toe].map((name) =>
                    distance(frame.positions[name], first.positions[name], true),
                  ),
                ),
              ),
              minSoleHeightMetres:
                values[0].soles[side] === null
                  ? null
                  : Math.min(...values.map((frame) => frame.soles[side])),
              maxSoleHeightMetres:
                values[0].soles[side] === null
                  ? null
                  : Math.max(...values.map((frame) => frame.soles[side])),
            };
          }
          episodes.push({
            side,
            startSec: frames[start].time,
            endSec: frames[end].time,
            ...metrics,
          });
        }
        start = null;
      }
    }
  }
  return episodes;
}

async function main() {
  const output = path.resolve(
    process.argv[2] ?? path.join(root, "docs/decisions/conversation-retarget-metrics.json"),
  );
  if (path.extname(output) !== ".json") throw new Error("Report output must be JSON");
  const buffers = Object.fromEntries(
    await Promise.all(
      Object.entries(files).map(async ([name, file]) => [name, await fs.readFile(file)]),
    ),
  );
  const currentAnimation = await loadAnimation(buffers.current),
    faithfulAnimation = await loadAnimation(buffers.faithful);
  const duration = Math.min(currentAnimation.duration, faithfulAnimation.duration);
  const source = sample(await createRig(buffers.faithful, false), faithfulAnimation, duration);
  const current = sample(await createRig(buffers.model, true), currentAnimation, duration);
  const faithful = sample(await createRig(buffers.model, true), faithfulAnimation, duration);
  const report = {
    schemaVersion: 1,
    inputs: Object.fromEntries(
      Object.entries(buffers).map(([name, buffer]) => [
        name,
        { file: path.relative(root, files[name]), sha256: hash(buffer) },
      ]),
    ),
    method: {
      sampleHz,
      durationSec: duration,
      source:
        "Prepared source-normalized skeleton and unchanged full-body recording; previous same-source FK roundtrip verified it against original FBX.",
      target:
        "Original Yori glTF geometry, skin, inverse binds and humanoid rest hierarchy. Textures/materials omitted only in memory. Official createVRMAnimationClip + AnimationMixer, weight1, speed1, VRM0 rotation, no body/procedural/masking/conditioning/IK.",
      sourceToTargetHipHeightScale:
        faithful.rig.humanoid.normalizedRestPose.hips.position[1] /
        faithfulAnimation.restHipsPosition.y,
      comparisonTiming:
        "Same clip-local time. Faithful clip0 is source0.1s; older clip0 best diagnostic offset was source0.0966667s, so up to one source-frame timing mismatch remains.",
      contactProxy:
        "Intervals >=0.4s where both source ankle/toe speeds <0.04m/s and source toe Y is within0.015m of its clip minimum. Same source-derived intervals measure all lanes; these are inferred quiet support intervals, not authored contact labels.",
      shoeVertices:
        "Rest-world Y <=0.15m and >=50% skin influence from the same-side Foot/Toes bones. Minimum Y of actual skinned vertices compared to that shoe's unanimated rest minimum; no guessed ankle floor.",
      limitations: [
        "Fidelity/grounding diagnostics, not perceptual superiority over Animates.",
        "Source foot motion may contain capture drift; low-speed contact inference is not ground truth.",
        "Per-shoe rest minima diagnose shoe sinking/hover relative to the model's own floor. The lab grid remains at worldY0.",
        "No retargeting correction or source asset replacement is performed.",
      ],
    },
    source: summarize(source),
    currentYori: summarize(current),
    faithfulYori: summarize(faithful),
    browserCheckpoints: [0, 3, 8, 15, 25].map((time) => ({
      time,
      currentYori: current.frames[Math.round(time * sampleHz)].positions,
      faithfulYori: faithful.frames[Math.round(time * sampleHz)].positions,
    })),
    quietSourceSupportEpisodes: contactEpisodes(source, {
      source,
      currentYori: current,
      faithfulYori: faithful,
    }),
  };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(
    output,
    `${JSON.stringify(report, (_key, value) => (typeof value === "number" ? round(value) : value), 2)}\n`,
  );
  console.log(
    JSON.stringify(
      {
        output,
        sourceToTargetHipHeightScale: report.method.sourceToTargetHipHeightScale,
        currentShoes: report.currentYori.shoes,
        faithfulShoes: report.faithfulYori.shoes,
        supportEpisodes: report.quietSourceSupportEpisodes.length,
      },
      null,
      2,
    ),
  );
}

export { createRig, glbParts, loadAnimation, sample, summarize };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();

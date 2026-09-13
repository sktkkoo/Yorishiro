#!/usr/bin/env node
/** Offline current-catalog transition audit: real Yori skeleton and Three mixer, no renderer. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
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
  process.argv[3] ??
    path.join(projectRoot, "docs/decisions/motion-candidate-compatibility-metrics.json"),
);
const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
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

await fs.mkdir(path.join(projectRoot, ".motion-review"), { recursive: true });
const temporaryDirectory = await fs.mkdtemp(
  path.join(projectRoot, ".motion-review/candidate-audit-"),
);
try {
  const modulePath = path.join(temporaryDirectory, "runtime.mjs");
  await build({
    stdin: {
      contents:
        'export { AnimationPlayer } from "./src/core/body/animation-player.ts"; export { measureMotionEntry, UPPER_BODY_TRANSITION_LIMITS } from "./src/core/body/motion-transition.ts"; export { DEFAULT_MOTION_CATALOG } from "./src/core/body/motion-catalog.ts"; export { applyVrmRestPose } from "./src/core/body/vrm-rest-pose.ts";',
      resolveDir: projectRoot,
    },
    bundle: true,
    packages: "external",
    format: "esm",
    platform: "node",
    outfile: modulePath,
    logLevel: "silent",
  });
  const {
    AnimationPlayer,
    measureMotionEntry,
    UPPER_BODY_TRANSITION_LIMITS,
    DEFAULT_MOTION_CATALOG,
    applyVrmRestPose,
  } = await import(pathToFileURL(modulePath).href);
  const modelBuffer = await fs.readFile(path.join(assetRoot, "models/Yori.vrm"));
  const modelJson = glbJson(modelBuffer);
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  const sources = [];
  for (const entry of DEFAULT_MOTION_CATALOG) {
    const buffer = await fs.readFile(
      path.join(assetRoot, "animations", `${entry.animation.slice(5)}.vrma`),
    );
    const gltf = await loader.parseAsync(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length),
      "",
    );
    sources.push({ entry, animation: gltf.userData.vrmAnimations[0], sha256: hash(buffer) });
  }
  function options(entry, finite = false) {
    return {
      mask: "upper-body",
      loop: !finite,
      weight: entry.weight,
      speed: entry.speed,
      transition: finite ? "immediate" : "matched",
      fadeInMs: 0,
    };
  }
  async function setup() {
    const vrm = createTarget(modelJson);
    vrm.meta = { metaVersion: vrm.metaVersion };
    applyVrmRestPose(vrm);
    const player = new AnimationPlayer(vrm);
    for (const source of sources) {
      const clip = createVRMAnimationClip(source.animation, vrm);
      clip.tracks = clip.tracks.filter(
        (track) => !track.name.endsWith(".position") && !track.name.endsWith(".scale"),
      );
      player.clipCache.set(source.entry.animation, clip);
      await player.preload(source.entry.animation, { mask: "upper-body", loop: true });
      await player.preload(source.entry.animation, { mask: "upper-body", loop: false });
    }
    player.update(1 / 60);
    player.update(1 / 60);
    return { player, vrm };
  }
  const measurements = [];
  const evaluate = (player, source, phase, state) => {
    for (const candidate of sources) {
      for (const finite of candidate.entry.contexts.includes("speech") ? [false, true] : [false]) {
        const opts = options(candidate.entry, finite);
        const profile = player.preparedProfiles.get(
          player.profileKey(candidate.entry.animation, opts.mask, opts.loop),
        );
        const result = measureMotionEntry(player.poseSnapshot, profile, {
          weight: opts.weight,
          speed: opts.speed,
          matched: opts.transition === "matched",
          loop: opts.loop,
        });
        const accepted = player.evaluateTransition(candidate.entry.animation, opts);
        measurements.push({
          from: source,
          phase,
          state,
          to: candidate.entry.id,
          finite,
          weight: opts.weight,
          accepted: accepted !== null,
          selectedCost: accepted?.cost ?? null,
          selectedStartTimeSec: accepted?.startTimeSec ?? null,
          ...result,
        });
      }
    }
  };
  const initial = await setup();
  evaluate(initial.player, "rest", 0, "rest");
  for (const source of sources) {
    for (const phase of [0.1, 0.25, 0.5, 0.75]) {
      const { player } = await setup();
      const opts = options(source.entry);
      const duration = player.clipCache.get(source.entry.animation).duration;
      await player.play(source.entry.animation, { ...opts, startTimeSec: phase * duration });
      player.update(1 / 60);
      player.update(1 / 60);
      evaluate(player, source.entry.id, phase, "steady");
      const other = sources.find(
        (item) =>
          item.entry.id === (source.entry.id === "speech-chat" ? "idle-balance" : "speech-chat"),
      );
      await player.play(other.entry.animation, {
        ...options(other.entry),
        startTimeSec: 2,
        fadeInMs: 1200,
      });
      for (let frame = 0; frame < 36; frame++) player.update(1 / 60);
      evaluate(player, `${source.entry.id}->${other.entry.id}`, phase, "half-fade");
      player.stopAll();
    }
  }
  const summarize = (rows) => {
    const range = (key) => {
      const values = rows.map((item) => item[key]).sort((a, b) => a - b);
      return {
        min: values[0],
        p50: values[Math.floor(values.length * 0.5)],
        p95: values[Math.floor(values.length * 0.95)],
        max: values[values.length - 1],
      };
    };
    return {
      count: rows.length,
      accepted: rows.filter((item) => item.accepted).length,
      cost: range("cost"),
      poseRmsRad: range("poseRmsRad"),
      maxBodyAngleRad: range("maxBodyAngleRad"),
      velocityRmsRadSec: range("velocityRmsRadSec"),
    };
  };
  const speechIds = new Set(
    sources
      .filter(({ entry }) => entry.contexts.includes("speech") && entry.intents.includes("explain"))
      .map(({ entry }) => entry.id),
  );
  const baselineStates = new Map();
  for (const measurement of measurements) {
    if (measurement.finite || !speechIds.has(measurement.to)) continue;
    const key = JSON.stringify([measurement.from, measurement.phase, measurement.state]);
    const rows = baselineStates.get(key) ?? [];
    rows.push(measurement);
    baselineStates.set(key, rows);
  }
  const blockedBaselineStates = [...baselineStates.values()].filter(
    (rows) => !rows.some((row) => row.accepted),
  );
  const report = {
    method:
      "Real Yori normalized target bones, Three mixer snapshots at 60 Hz after applyVrmRestPose. Existing upper-body runtime tracks/loop conditioning; no feet/contact or semantic-boundary inference. Four source phases, steady and half-fade into a different weighted recording, all nine catalog candidates. Exact current catalog weights at intensity 0.5 for both baseline and finite; finite uses entry0 without a semantic-boundary claim. Cost statistics describe the unconstrained best entry; acceptance searches all mechanically allowed entries against the limits. Cooldown/history and semantic eligibility are not simulated in this mechanical audit.",
    modelSha256: hash(modelBuffer),
    sources: sources.map(({ entry, sha256 }) => ({
      id: entry.id,
      animation: entry.animation,
      sha256,
    })),
    limits: UPPER_BODY_TRANSITION_LIMITS,
    summary: summarize(measurements),
    speechBaselineAvailability: {
      states: baselineStates.size,
      withCompatibleCandidate: baselineStates.size - blockedBaselineStates.length,
      blockedStates: blockedBaselineStates.map((rows) => ({
        from: rows[0].from,
        phase: rows[0].phase,
        state: rows[0].state,
      })),
    },
    byState: Object.fromEntries(
      ["rest", "steady", "half-fade"].map((state) => [
        state,
        summarize(measurements.filter((item) => item.state === state)),
      ]),
    ),
    byTarget: Object.fromEntries(
      sources.map(({ entry }) => [
        entry.id,
        {
          count: measurements.filter((item) => item.to === entry.id).length,
          accepted: measurements.filter((item) => item.to === entry.id && item.accepted).length,
        },
      ]),
    ),
    rejectedExamples: measurements
      .filter((item) => !item.accepted)
      .sort((a, b) => b.maxBodyAngleRad - a.maxBodyAngleRad)
      .slice(0, 8),
  };
  await fs.writeFile(
    path.join(projectRoot, ".motion-review/motion-candidate-compatibility-full.json"),
    `${JSON.stringify(measurements, null, 2)}\n`,
  );
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({ output, summary: report.summary, byState: report.byState }, null, 2),
  );
} finally {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}

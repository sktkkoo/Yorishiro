#!/usr/bin/env node
/** CPU actual-avatar replay; no native app changes or asset writes. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createVRMAnimationClip } from "@pixiv/three-vrm-animation";
import { build } from "esbuild";
import * as THREE from "three";
import { createRig, loadAnimation } from "./measure-conversation-retarget.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(
  process.argv[2] ?? path.join(root, ".motion-review/runtime-foot-contact"),
);
const weight = Number(process.argv[3] ?? 0.8075);
if (!Number.isFinite(weight) || weight <= 0 || weight > 1)
  throw new Error("Review weight must be greater than zero and at most one");
await fs.mkdir(output, { recursive: true });
const modulePath = path.join(output, "runtime.mjs");
await build({
  stdin: {
    contents:
      'export { AnimationPlayer } from "./src/core/body/animation-player.ts"; export { FootContactController } from "./src/core/body/foot-contact.ts"; export { REVIEWED_FOOT_CONTACTS } from "./src/core/body/reviewed-foot-contacts.ts"; export { applyVrmRestPose } from "./src/core/body/vrm-rest-pose.ts";',
    resolveDir: root,
  },
  bundle: true,
  packages: "external",
  format: "esm",
  platform: "node",
  outfile: modulePath,
  logLevel: "silent",
});
const { AnimationPlayer, FootContactController, REVIEWED_FOOT_CONTACTS, applyVrmRestPose } =
  await import(pathToFileURL(modulePath).href);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const model = await fs.readFile(path.join(root, "public/models/Yori.vrm"));
globalThis.fetch = async (url) =>
  new Response(await fs.readFile(path.join(root, "public", decodeURIComponent(url))));
const results = [];
for (const [name, key] of [
  ["Idle Chatting", "anim:Idle Chatting"],
  ["Idle Chatting 2", "anim:Idle Chatting 2"],
]) {
  const bytes = await fs.readFile(path.join(root, "public/animations", `${name}.vrma`));
  const source = await loadAnimation(bytes);
  const profile = REVIEWED_FOOT_CONTACTS[key];
  if (hash(bytes) !== profile.sourceSha256) throw new Error("Source mismatch");
  for (const startTimeSec of [0, 8]) {
    for (const mode of ["stripped", "preserved", "contact"]) {
      const enabled = mode === "contact";
      const vrm = await createRig(model, true);
      applyVrmRestPose(vrm);
      const controller = new FootContactController(vrm);
      const player = new AnimationPlayer(
        vrm,
        undefined,
        () => controller.restore(),
        () => controller.restore(),
      );
      const clip = createVRMAnimationClip(source, vrm);
      clip.tracks = clip.tracks.filter(
        (track) =>
          !track.name.endsWith(".scale") &&
          (mode !== "stripped" || !track.name.endsWith(".position")),
      );
      player.clipCache.set(
        mode === "stripped" ? `anim:${name}` : JSON.stringify([`anim:${name}`, "preserve"]),
        clip,
      );
      const playback = await player.play(`anim:${name}`, {
        loop: false,
        weight,
        speed: 1,
        startTimeSec,
        footContacts: enabled ? profile : undefined,
        rootMotion: mode === "preserved" ? "preserve" : undefined,
      });
      const samples = [];
      let maxLocalCorrectionDegrees = 0;
      let maxFootOrientationErrorDegrees = 0;
      const end = Math.min(profile.durationSec - startTimeSec + 0.5, 60);
      for (let frame = 0; frame < Math.ceil(end * 60); frame++) {
        controller.restore();
        player.update(1 / 60);
        vrm.scene.updateMatrixWorld(true);
        const originalRotations = Object.fromEntries(
          ["left", "right"].flatMap((side) =>
            ["UpperLeg", "LowerLeg", "Foot"].map((part) => [
              `${side}${part}`,
              vrm.humanoid.getNormalizedBoneNode(`${side}${part}`).quaternion.clone(),
            ]),
          ),
        );
        const originalFootOrientation = Object.fromEntries(
          ["left", "right"].map((side) => [
            side,
            vrm.humanoid
              .getNormalizedBoneNode(`${side}Foot`)
              .getWorldQuaternion(new THREE.Quaternion()),
          ]),
        );
        if (enabled) controller.update(1 / 60, player.getFootContactPlayback());
        vrm.humanoid.update();
        vrm.scene.updateMatrixWorld(true);
        const positions = {};
        for (const [name, rotation] of Object.entries(originalRotations))
          maxLocalCorrectionDegrees = Math.max(
            maxLocalCorrectionDegrees,
            (vrm.humanoid.getNormalizedBoneNode(name).quaternion.angleTo(rotation) * 180) / Math.PI,
          );
        for (const side of ["left", "right"])
          maxFootOrientationErrorDegrees = Math.max(
            maxFootOrientationErrorDegrees,
            (vrm.humanoid
              .getNormalizedBoneNode(`${side}Foot`)
              .getWorldQuaternion(new THREE.Quaternion())
              .angleTo(originalFootOrientation[side]) *
              180) /
              Math.PI,
          );
        for (const side of ["left", "right"])
          for (const part of ["UpperLeg", "LowerLeg", "Foot", "Toes"])
            positions[`${side}${part}`] = vrm.humanoid
              .getNormalizedBoneNode(`${side}${part}`)
              .getWorldPosition(new THREE.Vector3())
              .toArray();
        samples.push({
          time: (frame + 1) / 60,
          sourceTime: startTimeSec + (frame + 1) / 60,
          positions,
          soles: vrm.shoeMinima(),
          contact: controller.getSnapshot(),
        });
      }
      playback.cancel();
      const rejections = {};
      for (const sample of samples)
        if (sample.contact.rejected)
          rejections[sample.contact.rejected] = (rejections[sample.contact.rejected] ?? 0) + 1;
      const sides = {};
      for (const side of ["left", "right"]) {
        const episodes = profile[side]
          .map(([start, end]) => {
            const selected = samples.filter(
              (sample) =>
                sample.sourceTime > Math.max(start + 0.6, startTimeSec + 0.6) &&
                sample.sourceTime < end - 0.6,
            );
            if (!selected.length) return null;
            const centers = selected.map((sample) =>
              new THREE.Vector3()
                .fromArray(sample.positions[`${side}Foot`])
                .add(new THREE.Vector3().fromArray(sample.positions[`${side}Toes`]))
                .multiplyScalar(0.5),
            );
            const speeds = centers
              .slice(1)
              .map((value, index) => value.distanceTo(centers[index]) * 60)
              .sort((a, b) => a - b);
            return {
              start,
              end,
              frames: selected.length,
              maxCenterDriftMetres: Math.max(
                ...centers.map((value) => value.distanceTo(centers[0])),
              ),
              speedP95MetresPerSec: speeds[Math.floor(speeds.length * 0.95)],
              minimumSoleY: Math.min(...selected.map((sample) => sample.soles[side])),
              maximumSoleY: Math.max(...selected.map((sample) => sample.soles[side])),
            };
          })
          .filter(Boolean);
        sides[side] = episodes;
      }
      const result = {
        name,
        startTimeSec,
        mode,
        enabled,
        sourceSha256: hash(bytes),
        modelSha256: hash(model),
        weight,
        frames: samples.length,
        maxLocalCorrectionDegrees,
        maxFootOrientationErrorDegrees,
        rejections,
        sides,
        maxPelvisMetres: Math.max(
          ...samples.map((sample) => sample.contact.pelvisCorrectionMetres),
        ),
      };
      results.push(result);
      const file = `${key}-${startTimeSec}-${mode}.json`;
      await fs.writeFile(path.join(output, file), JSON.stringify({ result, samples }));
      console.log(JSON.stringify(result));
    }
  }
}
await fs.writeFile(path.join(output, "summary.json"), JSON.stringify(results, null, 2));

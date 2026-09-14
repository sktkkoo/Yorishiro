import { type VRM, VRMHumanoid } from "@pixiv/three-vrm";
import type { VRMAnimation } from "@pixiv/three-vrm-animation";
import * as THREE from "three";
import type { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { describe, expect, it, vi } from "vitest";
import { AnimationPlayer, type AnimationPlayOptions } from "./animation-player";

// A real binary VRMA, parsed by the player's official loader plugin. Source
// hips height 0.5 m retargets to a 1 m avatar, including all authored XYZ axes.
function recordedVrma(): ArrayBuffer {
  const data = new Float32Array([
    0,
    1,
    2,
    0,
    0.5,
    0,
    0.1,
    0.6,
    0.2,
    0.2,
    0.5,
    0.1,
    0,
    0,
    0,
    1,
    0,
    Math.sin(0.1),
    0,
    Math.cos(0.1),
    0,
    0,
    0,
    1,
  ]);
  const document = {
    asset: { version: "2.0" },
    extensionsUsed: ["VRMC_vrm_animation"],
    extensions: {
      VRMC_vrm_animation: {
        specVersion: "1.0",
        humanoid: { humanBones: { hips: { node: 0 }, head: { node: 1 } } },
      },
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: "SourceHips", translation: [0, 0.5, 0], children: [1] },
      { name: "SourceHead", translation: [0, 0.3, 0] },
    ],
    buffers: [{ byteLength: data.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 12 },
      { buffer: 0, byteOffset: 12, byteLength: 36 },
      { buffer: 0, byteOffset: 48, byteLength: 48 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "SCALAR", min: [0], max: [2] },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: 3, type: "VEC4" },
    ],
    animations: [
      {
        samplers: [
          { input: 0, output: 1 },
          { input: 0, output: 2 },
        ],
        channels: [
          { sampler: 0, target: { node: 0, path: "translation" } },
          { sampler: 1, target: { node: 1, path: "rotation" } },
        ],
      },
    ],
  };
  const json = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const buffer = new ArrayBuffer(12 + 8 + jsonLength + 8 + data.byteLength);
  const header = new DataView(buffer);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, buffer.byteLength, true);
  header.setUint32(12, jsonLength, true);
  header.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(buffer, 20, jsonLength).fill(32);
  new Uint8Array(buffer, 20, json.length).set(json);
  header.setUint32(20 + jsonLength, data.byteLength, true);
  header.setUint32(24 + jsonLength, 0x004e4942, true);
  new Uint8Array(buffer, 28 + jsonLength).set(new Uint8Array(data.buffer));
  return buffer;
}

function sourceRig(edit?: (animation: VRMAnimation) => void, metaVersion = "1") {
  const scene = new THREE.Object3D();
  const rawHips = new THREE.Object3D();
  rawHips.name = "TargetHips";
  rawHips.position.y = 1;
  const rawHead = new THREE.Object3D();
  rawHead.name = "TargetHead";
  rawHead.position.y = 0.4;
  rawHips.add(rawHead);
  scene.add(rawHips);
  scene.updateMatrixWorld(true);
  const humanoid = new VRMHumanoid({
    hips: { node: rawHips },
    head: { node: rawHead },
  } as ConstructorParameters<typeof VRMHumanoid>[0]);
  scene.add(humanoid.normalizedHumanBonesRoot);
  const player = new AnimationPlayer({ scene, humanoid, meta: { metaVersion } } as VRM);
  const loader = (player as unknown as { loader: GLTFLoader }).loader;
  const load = vi.spyOn(loader, "loadAsync").mockImplementation(async () => {
    const gltf = await loader.parseAsync(recordedVrma(), "");
    edit?.(gltf.userData.vrmAnimations[0]);
    return gltf;
  });
  const hips = humanoid.getNormalizedBoneNode("hips");
  const head = humanoid.getNormalizedBoneNode("head");
  if (!hips || !head) throw new Error("missing fixture bones");
  return { player, hips, head, load, humanoid };
}

const preserve = { rootMotion: "preserve", weight: 1, fadeInMs: 0, fadeOutMs: 0 } as const;

describe("explicit reviewed root motion", () => {
  it.each([
    "1",
    "0",
  ])("retains scaled XYZ through the official VRM %s retargeter and mixer", async (version) => {
    const { player, hips, head } = sourceRig(undefined, version);
    const original = hips.position.clone();
    await player.play("reviewed.vrma", preserve);
    player.update(1);
    const sign = version === "0" ? -1 : 1;
    expect(hips.position.x).toBeCloseTo(sign * 0.2, 6);
    expect(hips.position.y).toBeCloseTo(1.2, 6);
    expect(hips.position.z).toBeCloseTo(sign * 0.4, 6);
    expect(Math.abs(head.rotation.y)).toBeCloseTo(0.2, 6);
    player.update(1.01);
    expect(player.activeCount).toBe(0);
    expect(hips.position.distanceTo(original)).toBeLessThan(1e-8);
  });

  it.each([
    "preserve-first",
    "in-place-first",
    "concurrent",
  ])("isolates cached variants when loaded %s", async (order) => {
    const { player, hips, load } = sourceRig();
    if (order === "concurrent") {
      expect(
        await Promise.all([
          player.preload("reviewed.vrma", preserve),
          player.preload("reviewed.vrma"),
        ]),
      ).toEqual([true, true]);
    } else {
      const first = order === "preserve-first" ? preserve : {};
      const second = order === "preserve-first" ? {} : preserve;
      expect(await player.preload("reviewed.vrma", first)).toBe(true);
      expect(await player.preload("reviewed.vrma", second)).toBe(true);
    }
    expect(load).toHaveBeenCalledOnce();
    const restored = hips.position.clone();
    for (const policy of ["preserve", "in-place", "preserve"] as const) {
      const motion = await player.play("reviewed.vrma", { ...preserve, rootMotion: policy });
      player.update(1);
      expect(hips.position.x).toBeCloseTo(policy === "preserve" ? 0.2 : 0, 6);
      motion.cancel();
      expect(hips.position.distanceTo(restored)).toBeLessThan(1e-8);
    }
    expect(load).toHaveBeenCalledOnce();
  });

  it("fades the retained hips back to the binding rest pose and restores after cancel", async () => {
    const { player, hips } = sourceRig();
    const original = hips.position.clone();
    const motion = await player.play("reviewed.vrma", preserve);
    player.update(1);
    const stopping = motion.stop(200);
    player.update(0.1);
    expect(hips.position.x).toBeCloseTo(0.11, 6);
    expect(hips.position.y).toBeCloseTo(1.09, 6);
    expect(hips.position.z).toBeCloseTo(0.19, 6);
    player.update(0.101);
    await stopping;
    expect(hips.position.distanceTo(original)).toBeLessThan(1e-8);
    const replay = await player.play("reviewed.vrma", preserve);
    player.update(0.7);
    replay.cancel();
    expect(hips.position.distanceTo(original)).toBeLessThan(1e-8);
  });

  it("keeps default looping and upper-body variants in place after preserved preloading", async () => {
    const { player, hips, head } = sourceRig();
    expect(await player.preload("reviewed.vrma", preserve)).toBe(true);
    for (const mask of ["full-body", "upper-body"] as const) {
      const action = await player.play("reviewed.vrma", {
        mask,
        loop: true,
        fadeInMs: 0,
        weight: 1,
      });
      player.update(1);
      expect(hips.position.toArray()).toEqual([0, 1, 0]);
      expect(head.rotation.y).toBeGreaterThan(0.1);
      player.update(2);
      expect(hips.position.toArray()).toEqual([0, 1, 0]);
      action.cancel();
    }
  });

  it.each([
    { loop: true },
    { mask: "upper-body" },
    { mask: "lower-body" },
    { layer: "foundation" },
    { transition: "matched" },
  ] satisfies AnimationPlayOptions[])("rejects unsupported root policy combinations before loading: %j", async (options) => {
    const { player, load } = sourceRig();
    expect(await player.preload("reviewed.vrma", { ...preserve, ...options })).toBe(false);
    await expect(player.play("reviewed.vrma", { ...preserve, ...options })).rejects.toThrow(
      "requires a full-body, immediate, non-looping performance",
    );
    expect(load).not.toHaveBeenCalled();
    expect(player.activeCount).toBe(0);
  });

  it.each([
    [
      "zero source height",
      (source: VRMAnimation) => {
        source.restHipsPosition.y = 0;
      },
    ],
    [
      "nonfinite source rest",
      (source: VRMAnimation) => {
        source.restHipsPosition.x = NaN;
      },
    ],
    [
      "missing hips",
      (source: VRMAnimation) => {
        source.humanoidTracks.translation.clear();
      },
    ],
    [
      "infinite XYZ",
      (source: VRMAnimation) => {
        const track = source.humanoidTracks.translation.get("hips");
        if (!track) throw new Error("missing fixture hips");
        track.values[1] = Infinity;
      },
    ],
    [
      "duplicate time",
      (source: VRMAnimation) => {
        const track = source.humanoidTracks.translation.get("hips");
        if (!track) throw new Error("missing fixture hips");
        track.times[1] = 0;
      },
    ],
  ] as const)("fails closed for %s without poisoning the default variant", async (_name, edit) => {
    const { player, hips } = sourceRig(edit);
    expect(await player.preload("reviewed.vrma", preserve)).toBe(false);
    await expect(player.play("reviewed.vrma", preserve)).rejects.toThrow("rootMotion preserve");
    expect(player.activeCount).toBe(0);
    const motion = await player.play("reviewed.vrma", { weight: 1, fadeInMs: 0 });
    player.update(1);
    expect(hips.position.toArray()).toEqual([0, 1, 0]);
    motion.cancel();
  });

  it("rejects a nonpositive target rest height before retargeting", async () => {
    const { player, humanoid } = sourceRig();
    vi.spyOn(humanoid, "normalizedRestPose", "get").mockReturnValue({
      hips: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
    });
    expect(await player.preload("reviewed.vrma", preserve)).toBe(false);
    await expect(player.play("reviewed.vrma", preserve)).rejects.toThrow("target rest hips height");
    expect(player.activeCount).toBe(0);
  });

  it("rejects overflow after target scaling without retiring an existing action", async () => {
    const { player, hips } = sourceRig((source) => {
      source.restHipsPosition.y = 0.001;
      const track = source.humanoidTracks.translation.get("hips");
      if (!track) throw new Error("missing fixture hips");
      track.values[0] = 1e38;
    });
    const current = await player.play("reviewed.vrma", { loop: true, fadeInMs: 0 });
    player.update(0.5);
    await expect(player.play("reviewed.vrma", preserve)).rejects.toThrow("finite hips XYZ");
    expect(player.activeCount).toBe(1);
    expect(hips.position.toArray()).toEqual([0, 1, 0]);
    current.cancel();
  });
});

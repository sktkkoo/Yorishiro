import { type VRM, type VRMHumanBoneName, VRMHumanoid } from "@pixiv/three-vrm";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { AnimationPlayer } from "./animation-player";
import type { RecordedBaseOptions } from "./recorded-base-player";

function fixture(axialChain = false) {
  const scene = new THREE.Object3D();
  const raw = new Map<VRMHumanBoneName, THREE.Object3D>();
  const add = (name: VRMHumanBoneName, parent: THREE.Object3D, position: number[]) => {
    const bone = new THREE.Object3D();
    bone.name = name;
    bone.position.fromArray(position);
    parent.add(bone);
    raw.set(name, bone);
    return bone;
  };
  const hips = add("hips", scene, [0, 0.95, 0]);
  if (axialChain) {
    const spine = add("spine", hips, [0, 0.12, 0]);
    const chest = add("chest", spine, [0, 0.16, 0]);
    const neck = add("neck", chest, [0, 0.1, 0]);
    add("head", neck, [0, 0.12, 0]);
    for (const side of ["left", "right"] as const) {
      const arm = add(`${side}UpperArm`, chest, [side === "left" ? 0.15 : -0.15, 0.05, 0]);
      const forearm = add(`${side}LowerArm`, arm, [0.15, 0, 0]);
      const hand = add(`${side}Hand`, forearm, [0.15, 0, 0]);
      add(`${side}IndexProximal`, hand, [0.03, 0, 0]);
    }
  } else add("head", hips, [0, 0.5, 0]);
  for (const side of ["left", "right"] as const) {
    const thigh = add(`${side}UpperLeg`, hips, [side === "left" ? 0.1 : -0.1, -0.05, 0]);
    const shin = add(`${side}LowerLeg`, thigh, [0, -0.4, 0]);
    const foot = add(`${side}Foot`, shin, [0, -0.4, 0]);
    add(`${side}Toes`, foot, [0, -0.03, 0.12]);
  }
  scene.updateMatrixWorld(true);
  const humanoid = new VRMHumanoid(
    Object.fromEntries(
      [...raw].map(([name, node]) => [name, { node }]),
    ) as unknown as ConstructorParameters<typeof VRMHumanoid>[0],
  );
  scene.add(humanoid.normalizedHumanBonesRoot);
  const vrm = { scene, humanoid, meta: { metaVersion: "1" } } as VRM;
  const player = new AnimationPlayer(vrm);
  const node = (name: VRMHumanBoneName) => {
    const result = humanoid.getNormalizedBoneNode(name);
    if (!result) throw new Error(`Missing ${name}`);
    return result;
  };
  const cache = (player as unknown as { clipCache: Map<string, THREE.AnimationClip> }).clipCache;
  const recording = (ref: string, rootX = 0, drift = 0.006) => {
    const tracks: THREE.KeyframeTrack[] = [...raw.keys()].map(
      (name) =>
        new THREE.QuaternionKeyframeTrack(
          `${node(name).name}.quaternion`,
          [0, 1, 2],
          (name === "head" ? [0.2, 0.3, 0.4] : [0, 0, 0]).flatMap((angle) =>
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), angle).toArray(),
          ),
        ),
    );
    tracks.push(
      new THREE.VectorKeyframeTrack(
        `${node("hips").name}.position`,
        [0, 1, 2],
        [rootX, 0.95, 0, rootX + drift / 2, 0.95, 0, rootX + drift, 0.95, 0],
      ),
    );
    const clip = new THREE.AnimationClip(ref, 2, tracks);
    cache.set(JSON.stringify([ref, "preserve"]), clip);
    return clip;
  };
  const opts: RecordedBaseOptions = {
    startTimeSec: 0,
    endTimeSec: 1.5,
    fadeInMs: 0,
    contactWindows: [{ startTimeSec: 0, endTimeSec: 2, feet: "both" }],
  };
  return { player, node, recording, cache, opts, vrm };
}

describe("atomic recorded full-body base", () => {
  it("passes full-strength fractional samples through with the exact direct mixer precision", async () => {
    const current = fixture(true);
    const reference = fixture(true);
    current.recording("base");
    const source = reference.recording("base");
    const mixer = new THREE.AnimationMixer(reference.vrm.scene);
    mixer.clipAction(source).play();
    await current.player.playRecordedBase("base", {
      ...current.opts,
      initialPose: true,
      axialReferenceTimeSec: 0.8,
      getInitialState: () => ({
        paused: false,
        upperWeight: 1,
        axialStrength: { torso: 1, head: 1 },
      }),
    });
    for (const delta of [0.1333, 0.3333, 0.1117, 0.2881]) {
      current.player.update(delta);
      mixer.update(delta);
      for (const name of ["spine", "chest", "neck", "head"] as const)
        expect(current.node(name).quaternion.toArray()).toEqual(
          reference.node(name).quaternion.toArray(),
        );
    }
  });

  it("attenuates global torso and head motion, including inherited hips rotation, without changing limbs", async () => {
    const quiet = fixture(true);
    const source = fixture(true);
    const axis = new THREE.Vector3(0, 1, 0);
    for (const rig of [quiet, source]) {
      const clip = rig.recording("axial", 0, 0);
      for (const [name, angles] of [
        ["hips", [-0.05, 0, 0.05]],
        ["spine", [-0.1, 0.03, 0.16]],
        ["chest", [0.02, -0.02, 0.06]],
        ["neck", [-0.2, 0.02, 0.24]],
        ["head", [-0.1, 0.01, 0.12]],
        ["leftUpperArm", [0.3, 0.4, 0.5]],
        ["leftHand", [0.1, 0.2, 0.3]],
        ["leftIndexProximal", [0.2, 0.3, 0.4]],
      ] as const) {
        const track = clip.tracks.find(
          (track) => track.name === `${rig.node(name).name}.quaternion`,
        );
        if (!track) throw new Error(`Missing ${name}`);
        angles.forEach((angle, index) => {
          new THREE.Quaternion().setFromAxisAngle(axis, angle).toArray(track.values, index * 4);
        });
      }
    }
    const referenceTime = 1;
    const full = await source.player.playRecordedBase("axial", {
      ...source.opts,
      startTimeSec: referenceTime,
      initialPose: true,
    });
    const reference = new Map(
      (["spine", "chest", "neck", "head"] as const).map((name) => [
        name,
        source.node(name).getWorldQuaternion(new THREE.Quaternion()),
      ]),
    );
    full.cancel();
    const raw = await source.player.playRecordedBase("axial", source.opts);
    const filtered = await quiet.player.playRecordedBase("axial", {
      ...quiet.opts,
      initialPose: true,
      axialReferenceTimeSec: referenceTime,
      getInitialState: () => ({
        paused: false,
        upperWeight: 1,
        axialStrength: { torso: 0.18, head: 0.06 },
      }),
    });
    for (let frame = 0; frame < 90; frame++) {
      source.player.update(1 / 60);
      quiet.player.update(1 / 60);
      for (const name of ["spine", "chest", "neck", "head"] as const) {
        const neutral = reference.get(name) ?? new THREE.Quaternion();
        const gain = name === "spine" || name === "chest" ? 0.18 : 0.06;
        const originalAngle = source
          .node(name)
          .getWorldQuaternion(new THREE.Quaternion())
          .angleTo(neutral);
        const attenuatedAngle = quiet
          .node(name)
          .getWorldQuaternion(new THREE.Quaternion())
          .angleTo(neutral);
        expect(attenuatedAngle).toBeCloseTo(originalAngle * gain, 5);
      }
      for (const name of ["hips", "leftFoot", "rightFoot", "leftToes", "rightToes"] as const) {
        expect(quiet.node(name).position.distanceTo(source.node(name).position)).toBeLessThan(
          1e-10,
        );
        expect(quiet.node(name).quaternion.toArray()).toEqual(
          source.node(name).quaternion.toArray(),
        );
      }
      for (const name of ["leftUpperArm", "leftHand", "leftIndexProximal"] as const)
        expect(quiet.node(name).quaternion.toArray()).toEqual(
          source.node(name).quaternion.toArray(),
        );
      expect(quiet.player.getTotalEffectiveWeight()).toBe(1);
    }
    expect(filtered.phaseSec).toBe(raw.phaseSec);
  });

  it("retains the exact source at full axial strength and blends semantic head ownership normally", async () => {
    const { player, node, recording, cache, opts } = fixture();
    const clip = recording("base");
    const original = clip.tracks.map((track) => [...track.values]);
    const base = await player.playRecordedBase("base", {
      ...opts,
      axialReferenceTimeSec: 0.8,
      getInitialState: () => ({
        paused: false,
        upperWeight: 1,
        axialStrength: { torso: 1, head: 1 },
      }),
    });
    player.update(0.5);
    expect(node("head").rotation.x).toBeCloseTo(0.25, 6);
    base.setAxialStrength({ torso: 0, head: 0 }, 500);
    player.update(0.25);
    expect(node("head").rotation.x).toBeCloseTo((0.28 + 0.275) / 2, 6);
    player.update(0.25);
    expect(node("head").rotation.x).toBeCloseTo(0.28, 6);
    cache.set(
      "head-gesture",
      new THREE.AnimationClip("head-gesture", 2, [
        new THREE.QuaternionKeyframeTrack(
          `${node("head").name}.quaternion`,
          [0, 2],
          [0.8, 0.8].flatMap((angle) =>
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), angle).toArray(),
          ),
        ),
      ]),
    );
    const gesture = await player.play("head-gesture", {
      mask: "upper-body",
      fadeInMs: 0,
      weight: 0.75,
    });
    player.update(0.1);
    expect(node("head").rotation.x).toBeCloseTo(0.28 * 0.25 + 0.8 * 0.75, 6);
    gesture.cancel();
    player.update(0.1);
    expect(node("head").rotation.x).toBeCloseTo(0.28, 6);
    base.setAxialStrength({ torso: 1, head: 1 });
    player.update(0.1);
    expect(node("head").rotation.x).toBeCloseTo(0.33, 6);
    expect(clip.tracks.map((track) => [...track.values])).toEqual(original);
    base.cancel();
    expect(node("head").rotation.x).toBeCloseTo(0, 6);
  });

  it("shares one authored axial reference across unit transitions and smooth paused strength changes", async () => {
    const { player, node, recording, opts } = fixture();
    recording("base");
    const settings = {
      ...opts,
      axialReferenceTimeSec: 0.8,
      getInitialState: () => ({
        paused: false,
        upperWeight: 1,
        axialStrength: { torso: 0, head: 0 },
      }),
    };
    const first = await player.playRecordedBase("base", settings);
    player.update(1.5);
    await first.completion;
    expect(node("head").rotation.x).toBeCloseTo(0.28, 6);
    const next = await player.playRecordedBase("base", {
      ...settings,
      startTimeSec: 0.4,
      fadeInMs: 800,
    });
    for (let frame = 0; frame < 49; frame++) {
      player.update(1 / 60);
      expect(node("head").rotation.x).toBeCloseTo(0.28, 6);
      expect(player.getFoundationEffectiveWeight()).toBeCloseTo(1, 12);
    }
    next.setPaused(true);
    const phase = next.phaseSec;
    next.setAxialStrength({ torso: 1, head: 1 }, 500);
    player.update(0.25);
    expect(next.phaseSec).toBe(phase);
    expect(node("head").rotation.x).toBeCloseTo((0.28 + 0.2 + phase * 0.1) / 2, 6);
    expect(player.hasActiveRecordedBase()).toBe(true);
    player.update(0.25);
    expect(node("head").rotation.x).toBeCloseTo(0.2 + phase * 0.1, 6);
    expect(player.hasActiveRecordedBase()).toBe(false);
  });

  it("rejects invalid reference times before committing and clamps invalid gains to finite poses", async () => {
    const { player, node, recording, opts } = fixture();
    recording("base");
    const onCommit = vi.fn();
    for (const axialReferenceTimeSec of [-1, Number.NaN, Number.POSITIVE_INFINITY, 3])
      await expect(
        player.playRecordedBase("base", { ...opts, axialReferenceTimeSec, onCommit }),
      ).rejects.toThrow("axial reference");
    expect(onCommit).not.toHaveBeenCalled();
    const base = await player.playRecordedBase("base", opts);
    base.setAxialStrength({ torso: Number.NaN, head: Number.POSITIVE_INFINITY });
    player.update(0.5);
    expect(node("head").rotation.x).toBeCloseTo(0.2, 6);
    expect(node("head").quaternion.toArray().every(Number.isFinite)).toBe(true);
  });

  it("scales the upper performance while preserving lower trajectories, then pauses and resumes in place", async () => {
    const current = fixture();
    const reference = fixture();
    current.recording("base");
    reference.recording("base");
    const base = await current.player.playRecordedBase("base", {
      ...current.opts,
      initialPose: true,
      getInitialState: () => ({ paused: false, upperWeight: 0.95 }),
    });
    await reference.player.playRecordedBase("base", { ...reference.opts, initialPose: true });
    expect(current.node("head").rotation.x).toBeCloseTo(0.2 * 0.95, 6);
    for (const weight of [0.5, 0.95, 1]) {
      base.setUpperWeight(weight, 100);
      for (let frame = 0; frame < 6; frame++) {
        current.player.update(1 / 60);
        reference.player.update(1 / 60);
        for (const name of ["hips", "leftFoot", "leftToes", "rightFoot", "rightToes"] as const)
          expect(
            current
              .node(name)
              .getWorldPosition(new THREE.Vector3())
              .distanceTo(reference.node(name).getWorldPosition(new THREE.Vector3())),
          ).toBeLessThan(1e-10);
        expect(current.player.getFoundationEffectiveWeight()).toBe(1);
      }
      expect(current.node("head").rotation.x).toBeCloseTo(
        reference.node("head").rotation.x * weight,
        6,
      );
    }
    const phase = base.phaseSec;
    const foot = current.node("leftFoot").getWorldPosition(new THREE.Vector3());
    const completed = vi.fn();
    void base.completion.then(completed);
    base.setPaused(true);
    base.setUpperWeight(0, 350);
    expect(current.player.hasActiveRecordedBase()).toBe(true); // the fade still needs frames
    current.player.update(5);
    await Promise.resolve();
    expect(base.phaseSec).toBe(phase);
    expect(base.paused).toBe(true);
    expect(base.held).toBe(false);
    expect(completed).not.toHaveBeenCalled();
    expect(current.player.activeCount).toBe(2);
    expect(current.player.hasActiveRecordedBase()).toBe(false);
    expect(current.player.getFoundationEffectiveWeight()).toBe(1);
    expect(current.player.getTotalEffectiveWeight()).toBe(0);
    expect(current.node("leftFoot").getWorldPosition(new THREE.Vector3()).distanceTo(foot)).toBe(0);
    base.setPaused(false);
    base.setUpperWeight(0.95, 100);
    current.player.update(0.1);
    reference.player.update(0.1);
    expect(base.phaseSec).toBeCloseTo(phase + 0.1, 12);
    expect(current.node("hips").position.distanceTo(reference.node("hips").position)).toBeLessThan(
      1e-10,
    );
    expect(current.player.hasActiveRecordedBase()).toBe(true);
  });

  it("commits a cold zero-strength stance paused before its first mixer evaluation", async () => {
    const { player, node, recording, opts } = fixture();
    recording("base");
    let strength = 0.95;
    const base = await player.playRecordedBase("base", {
      ...opts,
      startTimeSec: 0.5,
      initialPose: true,
      onCommit: () => {
        strength = 0;
      },
      getInitialState: () => ({ paused: strength === 0, upperWeight: strength }),
    });
    expect(base.paused).toBe(true);
    expect(node("head").rotation.x).toBe(0);
    expect(player.getFoundationEffectiveWeight()).toBe(1);
    expect(player.hasActiveRecordedBase()).toBe(false);
    const initial = node("hips").position.clone();
    player.update(10);
    expect(base.phaseSec).toBe(0.5);
    expect(node("hips").position.distanceTo(initial)).toBe(0);
    base.setPaused(false);
    player.update(0.25);
    expect(base.phaseSec).toBe(0.75);
    expect(node("hips").position.x - initial.x).toBeCloseTo(0.00075, 7);
  });

  it("finishes common fades and cancellation while the incoming source clock is paused", async () => {
    const { player, recording, opts } = fixture();
    recording("base");
    const first = await player.playRecordedBase("base", opts);
    player.update(1.5);
    await first.completion;
    const next = await player.playRecordedBase("base", { ...opts, fadeInMs: 800 });
    player.update(0.2);
    const phase = next.phaseSec;
    next.setPaused(true);
    next.setUpperWeight(0, 350);
    for (let frame = 0; frame < 40; frame++) {
      player.update(1 / 60);
      expect(player.getFoundationEffectiveWeight()).toBeCloseTo(1, 12);
      expect(next.phaseSec).toBe(phase);
    }
    expect(player.activeCount).toBe(2);
    expect(player.hasActiveRecordedBase()).toBe(false);
    const stopped = next.stop(300);
    expect(player.hasActiveRecordedBase()).toBe(true);
    player.update(0.3);
    await stopped;
    expect(player.activeCount).toBe(0);
  });

  it("validates the same leg slerp as the mixer when hips compensate a gradual knee bend", async () => {
    const { player, node, recording, opts } = fixture();
    const clip = recording("bent", 0, 0);
    for (const side of ["left", "right"] as const) {
      for (const [part, angle] of [
        ["UpperLeg", 0.2],
        ["LowerLeg", -0.4],
        ["Foot", 0.2],
      ] as const) {
        const track = clip.tracks.find(
          (track) => track.name === `${node(`${side}${part}`).name}.quaternion`,
        );
        if (!track) throw new Error("Missing bend channel");
        for (let key = 0; key < track.values.length; key += 4)
          new THREE.Quaternion()
            .setFromAxisAngle(new THREE.Vector3(1, 0, 0), angle)
            .toArray(track.values, key);
      }
    }
    const position = clip.tracks[clip.tracks.length - 1];
    for (let key = 1; key < position.values.length; key += 3)
      position.values[key] = 0.95 - 0.8 * (1 - Math.cos(0.2));
    const foot = node("leftFoot");
    const initial = foot.getWorldPosition(new THREE.Vector3());
    await player.playRecordedBase("bent", { ...opts, fadeInMs: 800 });
    let maximumDrop = 0;
    for (let frame = 0; frame < 49; frame++) {
      player.update(1 / 60);
      maximumDrop = Math.max(maximumDrop, initial.y - foot.getWorldPosition(new THREE.Vector3()).y);
    }
    expect(maximumDrop).toBeGreaterThan(0.003);
    expect(maximumDrop).toBeLessThan(0.0041);
    expect(foot.getWorldPosition(new THREE.Vector3()).distanceTo(initial)).toBeLessThan(1e-6);
  });

  it("initializes an authored stance only before first presentation, then forbids late bootstrap", async () => {
    const { player, node, recording, opts } = fixture();
    recording("offset", 0.3);
    const base = await player.playRecordedBase("offset", { ...opts, initialPose: true });
    // Initial presentation is evaluated atomically; the renderer never sees the rest stance.
    expect(node("hips").position.x).toBeCloseTo(0, 6);
    expect(node("head").rotation.x).toBeCloseTo(0.2, 6);
    expect(base.phaseSec).toBe(0);
    player.update(0.5);
    // Constant placement removes the source's entrance location, not its motion.
    expect(node("hips").position.x).toBeCloseTo(0.0015, 6);
    base.cancel();
    await expect(player.playRecordedBase("offset", { ...opts, initialPose: true })).rejects.toThrow(
      "first playback or update",
    );
    const second = fixture();
    second.recording("base");
    second.player.update(0);
    await expect(
      second.player.playRecordedBase("base", { ...second.opts, initialPose: true }),
    ).rejects.toThrow("first playback or update");
  });

  it("rechecks ownership after an onCommit callback that synchronously cancels the pending request", async () => {
    const { player, recording, opts } = fixture();
    recording("base");
    await expect(
      player.playRecordedBase("base", { ...opts, onCommit: () => player.stopAll() }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(player.activeCount).toBe(0);
  });

  it("predicts semantic seams against the current base phase and gain, including the standing remainder", async () => {
    const { player, node, recording, cache, opts } = fixture();
    const clip = recording("base");
    const head = clip.tracks.find((track) => track.name === `${node("head").name}.quaternion`);
    if (!head) throw new Error("No head");
    for (let key = 0; key < head.values.length; key += 4)
      new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.3)
        .toArray(head.values, key);
    const gesture = new THREE.AnimationClip("gesture", 3, [
      new THREE.QuaternionKeyframeTrack(
        head.name,
        [0, 3],
        [1, 1].flatMap((angle) =>
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), angle).toArray(),
        ),
      ),
    ]);
    cache.set("gesture", gesture);
    const playback = {
      mask: "upper-body",
      loop: false,
      weight: 0.5,
      speed: 1,
      transition: "immediate",
    } as const;
    await player.preload("gesture", playback);
    const base = await player.playRecordedBase("base", opts);
    base.setUpperWeight(0.5);
    player.update(0.1);
    await player.play("gesture", { ...playback, fadeInMs: 0 });
    player.update(0.1);
    player.update(0.1);
    expect(node("head").rotation.x).toBeCloseTo(0.575, 6);
    expect(player.evaluateTransition("gesture", playback)?.cost).toBeLessThan(1e-10);
  });

  it("matches one full-body action, carries hips XYZ, and holds both halves at the exact selected end", async () => {
    const { player, node, recording, opts, vrm } = fixture();
    const clip = recording("base");
    const sourceValues = clip.tracks.map((track) => [...track.values]);
    expect(await player.preloadRecordedBase("base")).toBe(true);
    const base = await player.playRecordedBase("base", opts);
    const completed = vi.fn();
    void base.completion.then(completed);
    player.update(0.75);
    expect(base.phaseSec).toBeCloseTo(0.75, 12);
    expect(node("head").rotation.x).toBeCloseTo(0.275, 6);
    expect(node("hips").position.x).toBeCloseTo(0.00225, 7);
    expect(player.activeCount).toBe(2);
    expect(player.getTotalEffectiveWeight()).toBe(1);
    expect(player.getFoundationEffectiveWeight()).toBe(1);
    const actual = new Map(
      [...Object.values(vrm.humanoid.normalizedHumanBones)].map(({ node: bone }) => [
        bone.name,
        [...bone.position, ...bone.quaternion],
      ]),
    );
    base.cancel();
    const mixer = new THREE.AnimationMixer(vrm.scene);
    mixer.clipAction(clip).setEffectiveWeight(1).play();
    mixer.setTime(0.75);
    for (const { node: bone } of Object.values(vrm.humanoid.normalizedHumanBones)) {
      const expected = actual.get(bone.name) ?? [];
      [...bone.position, ...bone.quaternion].forEach((value, index) => {
        expect(value).toBeCloseTo(expected[index], 7);
      });
    }
    mixer.stopAllAction();
    const held = await player.playRecordedBase("base", opts);
    player.update(4);
    await held.completion;
    expect(held.held).toBe(true);
    expect(held.phaseSec).toBe(1.5);
    expect(node("head").rotation.x).toBeCloseTo(0.35, 6);
    const position = node("hips").position.clone();
    player.update(100);
    expect(node("hips").position.distanceTo(position)).toBe(0);
    expect(node("head").rotation.x).toBeCloseTo(0.35, 6);
    expect(player.activeCount).toBe(2);
    expect(clip.tracks.map((track) => [...track.values])).toEqual(sourceValues);
  });

  it("ducks only the upper base beneath semantic gestures and resumes its current synchronized phase", async () => {
    const { player, node, recording, cache, opts } = fixture();
    recording("base");
    cache.set(
      "gesture",
      new THREE.AnimationClip("gesture", 3, [
        new THREE.QuaternionKeyframeTrack(
          `${node("head").name}.quaternion`,
          [0, 3],
          [0.8, 0.8].flatMap((angle) =>
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), angle).toArray(),
          ),
        ),
      ]),
    );
    const base = await player.playRecordedBase("base", opts);
    player.update(0.5);
    const gesture = await player.play("gesture", { mask: "upper-body", weight: 0.75, fadeInMs: 0 });
    player.update(0.5);
    expect(node("head").rotation.x).toBeCloseTo(0.8 * 0.75 + 0.3 * 0.25, 6);
    expect(node("hips").position.x).toBeCloseTo(0.003, 7);
    expect(player.getFoundationEffectiveWeight()).toBe(1);
    expect(player.getTotalEffectiveWeight()).toBe(1);
    gesture.cancel();
    player.update(0.25);
    expect(node("head").rotation.x).toBeCloseTo(0.325, 6);
    expect(base.phaseSec).toBe(1.25);
    base.setUpperWeight(0, 500);
    player.update(0.25);
    expect(node("head").rotation.x).toBeCloseTo(0.35 * 0.5, 6);
    player.update(0.25);
    expect(node("head").rotation.x).toBeCloseTo(0, 6);
    expect(player.getTotalEffectiveWeight()).toBe(0);
    expect(player.getFoundationEffectiveWeight()).toBe(1);
  });

  it("aligns each incoming root to the held contact anchor while both lower fade weights sum to one", async () => {
    const { player, node, recording, opts } = fixture();
    recording("first", 3);
    recording("next", -4);
    const first = await player.playRecordedBase("first", opts);
    player.update(2);
    await first.completion;
    const anchor = node("hips").position.x;
    const second = await player.playRecordedBase("next", { ...opts, fadeInMs: 800 });
    for (let frame = 0; frame < 48; frame++) {
      player.update(1 / 60);
      expect(player.getFoundationEffectiveWeight()).toBeCloseTo(1, 12);
      expect(node("hips").position.x).toBeGreaterThanOrEqual(anchor - 1e-6);
      expect(node("hips").position.x).toBeLessThan(anchor + 0.004);
    }
    expect(second.phaseSec).toBeCloseTo(0.8, 12);
    expect(player.activeCount).toBe(2);
  });

  it("keeps the outgoing hold and avoids onCommit when contact, speed or support gates fail", async () => {
    const { player, node, recording, opts } = fixture();
    recording("first");
    const bad = recording("wide");
    const thigh = bad.tracks.find(
      (track) => track.name === `${node("leftUpperLeg").name}.quaternion`,
    );
    if (!thigh) throw new Error("Missing thigh");
    for (let key = 0; key < thigh.values.length; key += 4)
      new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.2)
        .toArray(thigh.values, key);
    recording("moving", 0, 0.2);
    const first = await player.playRecordedBase("first", opts);
    player.update(2);
    const onCommit = vi.fn();
    await expect(player.playRecordedBase("wide", { ...opts, onCommit })).rejects.toThrow(
      "foot limits",
    );
    await expect(player.playRecordedBase("moving", { ...opts, onCommit })).rejects.toThrow(
      "moving too quickly",
    );
    await expect(
      player.playRecordedBase("first", {
        ...opts,
        onCommit,
        contactWindows: [{ startTimeSec: 0.2, endTimeSec: 2, feet: "both" }],
      }),
    ).rejects.toThrow("reviewed both-foot support");
    expect(onCommit).not.toHaveBeenCalled();
    expect(first.held).toBe(true);
    expect(player.activeCount).toBe(2);
  });

  it("does not mutate the live skeleton during preload or rejected fade-path checks", async () => {
    const { player, node, recording, opts } = fixture();
    const clip = recording("bad-height");
    const positions = clip.tracks[clip.tracks.length - 1];
    if (!positions) throw new Error("No hips");
    positions.values[4] += 0.08;
    node("head").rotation.x = -0.31;
    const before = node("head").quaternion.clone();
    expect(await player.preloadRecordedBase("bad-height")).toBe(true);
    // Boundary endpoints at 0 and 2 are low-speed but a fade through the middle is unsafe.
    await expect(
      player.playRecordedBase("bad-height", { ...opts, endTimeSec: 2, fadeInMs: 2_000 }),
    ).rejects.toThrow();
    expect(node("head").quaternion.angleTo(before)).toBe(0);
    expect(player.activeCount).toBe(0);
  });

  it("rejects intermediate foot sinking even when entry and exit velocities and endpoint positions are safe", async () => {
    const { player, node, recording, opts } = fixture();
    const clip = recording("dip", 0, 0);
    const positions = clip.tracks[clip.tracks.length - 1];
    if (!positions) throw new Error("No hips");
    const replacement = new THREE.VectorKeyframeTrack(
      positions.name,
      [0, 0.1, 0.5, 0.9, 1, 2],
      [0, 0.95, 0, 0, 0.95, 0, 0, 0.9, 0, 0, 0.95, 0, 0, 0.95, 0, 0, 0.95, 0],
    );
    clip.tracks[clip.tracks.length - 1] = replacement;
    const onCommit = vi.fn();
    await expect(
      player.playRecordedBase("dip", { ...opts, endTimeSec: 1, fadeInMs: 1_000, onCommit }),
    ).rejects.toThrow("foot limits");
    expect(onCommit).not.toHaveBeenCalled();
    expect(node("hips").position.y).toBeCloseTo(0.95, 6);
  });

  it("commits only after validation and refuses overlapping legacy lower owners", async () => {
    const { player, recording, cache, opts } = fixture();
    const clip = recording("base");
    cache.set("old", clip);
    const foundation = await player.play("old", {
      mask: "lower-body",
      layer: "foundation",
      fadeInMs: 0,
      weight: 1,
    });
    player.update(0.1);
    await expect(player.playRecordedBase("base", opts)).rejects.toThrow(
      "exclusive lower-body ownership",
    );
    expect(player.activeCount).toBe(1);
    const onCommit = vi.fn(() => foundation.cancel());
    await player.playRecordedBase("base", { ...opts, onCommit });
    player.update(0);
    expect(onCommit).toHaveBeenCalledOnce();
    expect(player.activeCount).toBe(2);
  });

  it("cancels stale loads and releases both bindings on stop, claim retirement and stopAll", async () => {
    const { player, node, recording, opts } = fixture();
    const clip = recording("base");
    let resolve = (_value: THREE.AnimationClip | null) => {};
    const load = vi.spyOn(
      player as unknown as {
        loadClip: (ref: string, policy: string) => Promise<THREE.AnimationClip | null>;
      },
      "loadClip",
    );
    load.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolve = res;
        }),
    );
    const pending = player.playRecordedBase("pending", opts);
    player.stopAll();
    resolve(clip);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(player.activeCount).toBe(0);
    const first = await player.playRecordedBase("base", opts);
    player.update(0.5);
    const stopping = first.stop(500);
    player.update(0.5);
    await stopping;
    expect(player.activeCount).toBe(0);
    expect(node("hips").position.x).toBeCloseTo(0, 8);
    const second = await player.playRecordedBase("base", opts);
    player.update(0.5);
    void second.stop(500);
    player.retireFadingActions();
    expect(player.activeCount).toBe(0);
    await player.playRecordedBase("base", opts);
    player.update(0.2);
    player.stopAll();
    expect(player.activeCount).toBe(0);
    expect(player.getFoundationEffectiveWeight()).toBe(0);
    expect(node("head").rotation.x).toBeCloseTo(0, 7);
  });
});

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  analyzeMotionClip,
  conditionMotionLoop,
  findMatchedEntry,
  findTransitionDelay,
  type MotionPoseJoint,
  measureMotionEntry,
} from "./motion-transition";

function clip(times: number[], angles: number[], duration = times[times.length - 1]) {
  return new THREE.AnimationClip("motion", duration, [
    new THREE.QuaternionKeyframeTrack(
      "Head.quaternion",
      times,
      angles.flatMap((angle) => [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)]),
    ),
  ]);
}

describe("motion transition analysis", () => {
  it("compares angular axes in a shared parent frame even from a rotated local pose", () => {
    const start = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const end = start
      .clone()
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1));
    const recording = new THREE.AnimationClip("rotated", 1, [
      new THREE.QuaternionKeyframeTrack(
        "Head.quaternion",
        [0, 1],
        [...start.toArray(), ...end.toArray()],
      ),
    ]);
    const current = new Map<string, MotionPoseJoint>([
      [
        "Head.quaternion",
        {
          pose: new Float32Array(start.toArray()),
          restPose: new Float32Array([0, 0, 0, 1]),
          velocity: new Float32Array([0, 1, 0]),
          velocityValid: true,
        },
      ],
    ]);
    const result = measureMotionEntry(current, analyzeMotionClip(recording), {
      weight: 1,
      speed: 1,
      matched: false,
      loop: false,
    });
    expect(result?.velocityRmsRadSec).toBeLessThan(1e-5);
  });

  it("can choose a safe phase when the globally cheapest phase violates a per-joint limit", () => {
    const recording = clip([0, 1], [0, 2]);
    recording.tracks.push(
      new THREE.QuaternionKeyframeTrack(
        "Shoulder.quaternion",
        [0, 1],
        [Math.sin(0.65), 0, 0, Math.cos(0.65), Math.sin(0.55), 0, 0, Math.cos(0.55)],
      ),
    );
    const pose = (): MotionPoseJoint => ({
      pose: new Float32Array([0, 0, 0, 1]),
      restPose: new Float32Array([0, 0, 0, 1]),
      velocity: new Float32Array(3),
      velocityValid: false,
    });
    const current = new Map([
      ["Head.quaternion", pose()],
      ["Shoulder.quaternion", pose()],
    ]);
    const target = analyzeMotionClip(recording);
    const options = { weight: 1, speed: 1, matched: true, loop: true };
    const unconstrained = measureMotionEntry(current, target, options);
    const constrained = measureMotionEntry(current, target, options, {
      poseRmsRad: 2,
      maxBodyAngleRad: 1.21,
      velocityRmsRadSec: 10,
      cost: 10,
    });
    expect(unconstrained?.maxBodyAngleRad).toBeGreaterThan(1.21);
    expect(constrained?.maxBodyAngleRad).toBeLessThanOrEqual(1.21);
    expect(constrained?.startTimeSec).toBeGreaterThan(0.4);
  });

  it("keeps axis direction and applies candidate weight to angular velocity", () => {
    const pose: MotionPoseJoint = {
      pose: new Float32Array([0, 0, 0, 1]),
      restPose: new Float32Array([0, 0, 0, 1]),
      velocity: new Float32Array([0.4, 0, 0]),
      velocityValid: true,
    };
    const current = new Map([["Head.quaternion", pose]]);
    const options = { weight: 0.4, speed: 1, matched: false, loop: false };
    const forward = measureMotionEntry(current, analyzeMotionClip(clip([0, 1], [0, 1])), options);
    const reverse = measureMotionEntry(current, analyzeMotionClip(clip([0, 1], [0, -1])), options);
    expect(forward?.cost).toBeLessThan(1e-10);
    expect(reverse?.cost).toBeCloseTo(0.08 * 0.8 ** 2, 5);
    expect(
      measureMotionEntry(new Map(), analyzeMotionClip(clip([0, 1], [0, 1])), options),
    ).toBeNull();
  });

  it("does not turn a low-velocity mid-gesture pose into an immediate semantic start", () => {
    const current = new Map<string, MotionPoseJoint>([
      [
        "Head.quaternion",
        {
          pose: new Float32Array([Math.sin(0.2), 0, 0, Math.cos(0.2)]),
          restPose: new Float32Array([0, 0, 0, 1]),
          velocity: new Float32Array(3),
          velocityValid: true,
        },
      ],
    ]);
    const target = analyzeMotionClip(clip([0, 0.5, 1.5, 2], [0, 0.4, 0.4, 0]));
    const options = { weight: 1, speed: 1, matched: false, loop: false };
    const immediate = measureMotionEntry(current, target, options);
    const matched = measureMotionEntry(current, target, { ...options, matched: true });
    expect(immediate?.startTimeSec).toBe(0);
    expect(matched?.startTimeSec).toBeGreaterThan(0.5);
    if (!matched || !immediate) throw new Error("Expected measurable entries");
    expect(matched.cost).toBeLessThan(immediate.cost);
  });

  it("extracts signed angular velocity in radians per second", () => {
    const profile = analyzeMotionClip(clip([0, 1], [0, -0.4]));
    const joint = profile.joints[0];
    expect(joint.velocities[15 * 3]).toBeCloseTo(-0.4, 4);
    expect(joint.velocities[15 * 3 + 1]).toBe(0);
    expect(profile.energy[15]).toBeCloseTo(0.16, 4);
  });

  it("matches both pose and motion direction rather than entering a reverse swing", () => {
    const source = analyzeMotionClip(clip([0, 1], [0, 1]));
    const target = analyzeMotionClip(clip([0, 1, 2, 3], [0, 1, 0, 1]));
    const time = findMatchedEntry(source, 0.5, target, { loop: true });
    const index = Math.round(time / target.sampleInterval);
    const angularError = Math.abs(2 * Math.asin(target.joints[0].poses[index * 4]) - 0.5);
    expect(angularError).toBeLessThan(0.08);
    expect(target.joints[0].velocities[index * 3]).toBeGreaterThan(0.9);
    expect(angularError).toBeLessThan(0.5 / 5); // At least 5x less entry mismatch than frame zero.
  });

  it("does not confuse equivalent quaternion signs with a pose discontinuity", () => {
    const source = analyzeMotionClip(clip([0, 1], [0.4, 0.4]));
    const targetClip = clip([0, 1], [0.4, 0.4]);
    targetClip.tracks[0].values = targetClip.tracks[0].values.map((value) => -value);
    const target = analyzeMotionClip(targetClip);
    expect(findMatchedEntry(source, 0.3, target)).toBe(0);
    expect(target.energy[15]).toBeCloseTo(0, 6);
  });

  it("finds a lower-velocity exit without exceeding the response delay budget", () => {
    const profile = analyzeMotionClip(clip([0, 0.1, 0.2, 1], [0, 0.4, 0.4, 0.4]));
    const delay = findTransitionDelay(profile, 0, 0.25);
    expect(delay).toBeGreaterThan(0.05);
    expect(delay).toBeLessThanOrEqual(0.25);
    expect(profile.energy[Math.round(delay / profile.sampleInterval)]).toBeLessThan(
      profile.energy[0],
    );
    expect(findTransitionDelay(profile, 0.4, 0.25)).toBe(0);
    expect(findTransitionDelay(profile, 0, 0)).toBe(0);
  });

  it("bounds preparation work and leaves enough time for non-looping entries", () => {
    const long = analyzeMotionClip(clip([0, 3600], [0, 1]));
    expect(long.sampleCount).toBeLessThanOrEqual(240);
    expect(long.entryCandidates.length).toBeLessThanOrEqual(48);
    expect([...long.energy].every(Number.isFinite)).toBe(true);
    const source = analyzeMotionClip(clip([0, 1], [1, 1]));
    const target = analyzeMotionClip(clip([0, 1], [0, 1]));
    expect(findMatchedEntry(source, 0, target, { minRemainingSec: 0.4 })).toBeLessThanOrEqual(0.6);
  });

  it("returns the semantic start for clips without shared rotation tracks", () => {
    const empty = analyzeMotionClip(new THREE.AnimationClip("empty", 0, []));
    const full = analyzeMotionClip(clip([0, 1], [0, 1]));
    expect(findMatchedEntry(empty, 0, full)).toBe(0);
    expect(findTransitionDelay(empty, 0, 0.3)).toBe(0);
  });
});

describe("recorded motion loop conditioning", () => {
  function sample(rotationClip: THREE.AnimationClip, time: number) {
    const scene = new THREE.Object3D();
    scene.name = "Head";
    const mixer = new THREE.AnimationMixer(scene);
    const action = mixer.clipAction(rotationClip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    mixer.update(time);
    return scene.quaternion.clone().normalize();
  }

  function angularVelocity(a: THREE.Quaternion, b: THREE.Quaternion, dt: number) {
    const rotation = a.clone().invert().multiply(b);
    if (rotation.w < 0) rotation.set(-rotation.x, -rotation.y, -rotation.z, -rotation.w);
    return (2 * Math.atan2(rotation.x, rotation.w)) / dt;
  }

  it("closes an unmatched final pose while preserving its initial angular velocity", () => {
    const original = clip([0, 0.5, 2], [0.2, 0.35, 1.1]);
    const seamless = conditionMotionLoop(original);
    const dt = 1 / 240;
    const first = sample(seamless, 0);
    const last = sample(seamless, 2);
    expect(first.angleTo(last)).toBeLessThan(1e-6);
    const incomingVelocity = angularVelocity(sample(seamless, 2 - dt), last, dt);
    const outgoingVelocity = angularVelocity(first, sample(seamless, dt), dt);
    expect(outgoingVelocity).toBeCloseTo(0.3, 4);
    expect(Math.abs(incomingVelocity - outgoingVelocity)).toBeLessThan(0.02);
    expect(sample(original, 0).angleTo(sample(original, 2))).toBeGreaterThan(0.8);
  });

  it("preserves authored prefix keys and samples without mutating the one-shot", () => {
    const original = clip([0, 0.4, 1.2, 2], [0.2, -0.1, 0.8, 1.1]);
    const originalValues = [...original.tracks[0].values];
    const originalTimes = [...original.tracks[0].times];
    const seamless = conditionMotionLoop(original);
    expect([...original.tracks[0].values]).toEqual(originalValues);
    expect([...original.tracks[0].times]).toEqual(originalTimes);
    expect([...seamless.tracks[0].values.slice(0, 12)]).toEqual(originalValues.slice(0, 12));
    for (const time of [0, 0.2, 0.9, 1.4]) {
      expect(sample(original, time).angleTo(sample(seamless, time))).toBeLessThan(1e-6);
    }
    expect(seamless.tracks[0].times.length).toBeLessThanOrEqual(originalTimes.length + 65);
  });

  it("uses local quaternion angular velocity even when the initial pose is rotated", () => {
    const initial = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -0.6, 0.2));
    const axis = new THREE.Vector3(0.4, 0.3, -0.2).normalize();
    const orientations = [0, 0.2, 1.2].map((angle) =>
      initial.clone().multiply(new THREE.Quaternion().setFromAxisAngle(axis, angle)),
    );
    const original = new THREE.AnimationClip("rotated", 2, [
      new THREE.QuaternionKeyframeTrack(
        "Head.quaternion",
        [0, 0.5, 2],
        orientations.flatMap((rotation) => rotation.toArray()),
      ),
    ]);
    const seamless = conditionMotionLoop(original);
    const dt = 1 / 240;
    const before = sample(seamless, 2 - dt)
      .invert()
      .multiply(sample(seamless, 2));
    const after = sample(seamless, 0).invert().multiply(sample(seamless, dt));
    expect(before.angleTo(after) / dt).toBeLessThan(0.025);
  });

  it("skips tiny clips and rejects unbounded duration before allocating samples", () => {
    const tiny = clip([0, 0.05], [0, 0.1]);
    expect(conditionMotionLoop(tiny)).toBe(tiny);
    const unbounded = clip([0, 1], [0, 1]);
    unbounded.duration = Infinity;
    expect(() => conditionMotionLoop(unbounded)).toThrow("duration must be finite");
  });

  it("repairs zero and non-finite rotation values instead of poisoning loop playback", () => {
    const malformed = clip([0, 0.5, 1], [0, 0, 0]);
    malformed.tracks[0].values.set([0, 0, 0, 0], 0);
    malformed.tracks[0].values.set([Infinity, NaN, 0, 1], 4);
    const seamless = conditionMotionLoop(malformed);
    expect([...seamless.tracks[0].values].every(Number.isFinite)).toBe(true);
    for (let i = 0; i <= 10; i++) {
      expect(sample(seamless, i / 10).length()).toBeCloseTo(1, 5);
    }
    const profile = analyzeMotionClip(seamless);
    expect([...profile.energy].every(Number.isFinite)).toBe(true);
  });
});

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { analyzeMotionClip, findMatchedEntry, findTransitionDelay } from "./motion-transition";

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

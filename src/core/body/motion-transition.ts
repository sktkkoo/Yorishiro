/** Bounded, one-time quaternion analysis for local motion matching. No service or model required. */
import * as THREE from "three";

export interface MotionJointSamples {
  readonly name: string;
  readonly weight: number;
  readonly poses: Float32Array;
  /** Local angular velocity, radians/second, including direction. */
  readonly velocities: Float32Array;
}

export interface MotionTransitionProfile {
  readonly duration: number;
  readonly sampleCount: number;
  readonly sampleInterval: number;
  readonly joints: readonly MotionJointSamples[];
  readonly energy: Float32Array;
  readonly entryCandidates: readonly number[];
}

const MAX_SAMPLES = 240;
const MAX_CANDIDATES = 48;

/** Analyze the already-retargeted clip, so every comparison uses the same avatar's local bones. */
export function analyzeMotionClip(
  clip: THREE.AnimationClip,
  jointWeights: ReadonlyMap<string, number> = new Map(),
): MotionTransitionProfile {
  const duration = Math.max(0, clip.duration);
  const sampleCount = Math.max(2, Math.min(MAX_SAMPLES, Math.ceil(duration * 30) + 1));
  const sampleInterval = duration / (sampleCount - 1);
  const energy = new Float32Array(sampleCount);
  const joints: MotionJointSamples[] = [];
  const previous = new THREE.Quaternion();
  const next = new THREE.Quaternion();
  const rotation = new THREE.Quaternion();
  let totalWeight = 0;

  for (const track of clip.tracks) {
    if (!track.name.endsWith(".quaternion") || track.getValueSize() !== 4) continue;
    // Three defines this factory at runtime, but @types/three omits the member.
    const interpolant = (
      track as THREE.KeyframeTrack & {
        createInterpolant: (result: Float32Array) => THREE.Interpolant;
      }
    ).createInterpolant(new Float32Array(4));
    const poses = new Float32Array(sampleCount * 4);
    const velocities = new Float32Array(sampleCount * 3);
    const weight = jointWeights.get(track.name) ?? 1;
    for (let i = 0; i < sampleCount; i++) {
      const sample = interpolant.evaluate(i * sampleInterval);
      previous
        .fromArray(sample)
        .normalize()
        .toArray(poses, i * 4);
    }
    for (let i = 0; i < sampleCount; i++) {
      const before = Math.max(0, i - 1);
      const after = Math.min(sampleCount - 1, i + 1);
      previous.fromArray(poses, before * 4);
      next.fromArray(poses, after * 4);
      rotation.copy(previous).invert().multiply(next).normalize();
      // q and -q represent the same pose; always use the shortest angular displacement.
      if (rotation.w < 0) rotation.set(-rotation.x, -rotation.y, -rotation.z, -rotation.w);
      const sinHalf = Math.hypot(rotation.x, rotation.y, rotation.z);
      const dt = (after - before) * sampleInterval;
      const factor =
        sinHalf > 1e-7 && dt > 0 ? (2 * Math.atan2(sinHalf, rotation.w)) / (sinHalf * dt) : 0;
      velocities[i * 3] = rotation.x * factor;
      velocities[i * 3 + 1] = rotation.y * factor;
      velocities[i * 3 + 2] = rotation.z * factor;
      energy[i] += weight * (sinHalf * factor) ** 2;
    }
    totalWeight += weight;
    joints.push({ name: track.name, weight, poses, velocities });
  }
  if (totalWeight > 0) {
    for (let i = 0; i < sampleCount; i++) energy[i] /= totalWeight;
  }

  // Keep local low-velocity windows plus coverage throughout the clip. Coverage
  // matters when two clips share a moving pose but have different resting poses.
  const minima: number[] = [];
  for (let i = 1; i < sampleCount - 1; i++) {
    if (energy[i] < energy[i - 1] && energy[i] <= energy[i + 1]) minima.push(i);
  }
  minima.sort((a, b) => energy[a] - energy[b]);
  const candidates = new Set<number>([0]);
  for (const i of minima.slice(0, MAX_CANDIDATES / 2)) candidates.add(i);
  for (let i = 0; i < MAX_CANDIDATES / 2; i++) {
    candidates.add(Math.round((i * (sampleCount - 1)) / (MAX_CANDIDATES / 2 - 1)));
  }
  return {
    duration,
    sampleCount,
    sampleInterval,
    joints,
    energy,
    entryCandidates: [...candidates].sort((a, b) => a - b),
  };
}

/** Choose a compatible entry phase. Explicit gestures should start at zero instead. */
export function findMatchedEntry(
  source: MotionTransitionProfile,
  sourceTime: number,
  target: MotionTransitionProfile,
  opts: {
    sourceSpeed?: number;
    targetSpeed?: number;
    loop?: boolean;
    minRemainingSec?: number;
  } = {},
): number {
  if (!source.joints.length || !target.joints.length || target.duration <= 0) return 0;
  const sourceIndex = sampleIndex(source, sourceTime);
  const targetByName = new Map(target.joints.map((joint) => [joint.name, joint]));
  const pairs = source.joints.flatMap((joint) => {
    const other = targetByName.get(joint.name);
    return other ? [{ source: joint, target: other }] : [];
  });
  if (pairs.length === 0) return 0;
  const sourceSpeed = opts.sourceSpeed ?? 1;
  const targetSpeed = opts.targetSpeed ?? 1;
  const lastEntry = opts.loop
    ? target.duration - target.sampleInterval
    : Math.max(0, target.duration - (opts.minRemainingSec ?? 0.4));
  let bestCost = Infinity;
  let bestTime = 0;
  for (const index of target.entryCandidates) {
    const time = index * target.sampleInterval;
    if (time > lastEntry) continue;
    let cost = 0;
    let weight = 0;
    for (const pair of pairs) {
      const a = pair.source;
      const b = pair.target;
      let dot = 0;
      for (let k = 0; k < 4; k++) dot += a.poses[sourceIndex * 4 + k] * b.poses[index * 4 + k];
      const angle = 2 * Math.acos(Math.min(1, Math.abs(dot)));
      let velocityDifference = 0;
      for (let k = 0; k < 3; k++) {
        const difference =
          a.velocities[sourceIndex * 3 + k] * sourceSpeed -
          b.velocities[index * 3 + k] * targetSpeed;
        velocityDifference += difference * difference;
      }
      cost += a.weight * (angle * angle + 0.08 * velocityDifference);
      weight += a.weight;
    }
    cost = cost / Math.max(weight, 1e-6) + 0.005 * target.energy[index] * targetSpeed ** 2;
    if (cost < bestCost) {
      bestCost = cost;
      bestTime = time;
    }
  }
  return bestTime;
}

/** Find a quieter outgoing window inside a strictly bounded response delay. */
export function findTransitionDelay(
  profile: MotionTransitionProfile,
  time: number,
  maxDelaySec: number,
  speed = 1,
  loop = true,
): number {
  if (maxDelaySec <= 0 || speed <= 0 || profile.duration <= 0) return 0;
  const startEnergy = profile.energy[sampleIndex(profile, time)];
  let bestEnergy = startEnergy;
  let delay = 0;
  // A fixed upper bound also handles an extreme QA delay without expensive scans.
  for (let i = 1; i <= 24; i++) {
    const candidateDelay = (maxDelaySec * i) / 24;
    const candidateTime = time + candidateDelay * speed;
    if (!loop && candidateTime >= profile.duration) break;
    const wrappedTime = loop ? candidateTime % profile.duration : candidateTime;
    const energy = profile.energy[sampleIndex(profile, wrappedTime)];
    // Require a useful reduction. Tiny noise should not add conversational latency.
    if (energy + startEnergy * 0.12 < bestEnergy) {
      bestEnergy = energy;
      delay = candidateDelay;
    }
  }
  return delay;
}

function sampleIndex(profile: MotionTransitionProfile, time: number): number {
  if (profile.sampleInterval <= 0) return 0;
  return Math.max(0, Math.min(profile.sampleCount - 1, Math.round(time / profile.sampleInterval)));
}

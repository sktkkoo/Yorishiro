import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import * as THREE from "three";
import type { MotionPoseJoint } from "./motion-transition";

export interface RecordedBaseContactWindow {
  readonly startTimeSec: number;
  readonly endTimeSec: number;
  readonly feet: "both";
}

export interface RecordedBaseOptions {
  readonly startTimeSec: number;
  readonly endTimeSec: number;
  readonly fadeInMs?: number;
  /** Reviewed target-space support windows; source-only contact inference is insufficient. */
  readonly contactWindows: readonly RecordedBaseContactWindow[];
  readonly isCurrent?: () => boolean;
  /** Runs after all gates pass, just before activation; only release existing lower owners. */
  readonly onCommit?: () => void;
  /** Only the owning AnimationPlayer may authorize a pose before its first update. */
  readonly initialPose?: boolean;
  /** Evaluated at commit so pending loads inherit the latest intensity and upper ownership. */
  readonly getInitialState?: () => { readonly paused: boolean; readonly upperWeight: number };
}

export interface RecordedBaseHandle {
  readonly id: number;
  readonly phaseSec: number;
  readonly held: boolean;
  readonly paused: boolean;
  /** Resolves at the selected end, where both tracks hold instead of fading to rest. */
  readonly completion: Promise<void>;
  setUpperWeight(value: number, fadeMs?: number): void;
  /** Freeze the source phase without releasing the supporting pose or fade deadlines. */
  setPaused(paused: boolean): void;
  stop(fadeMs?: number): Promise<void>;
  cancel(): void;
}

const LOWER_NAMES: readonly VRMHumanBoneName[] = [
  "hips",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "leftToes",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
  "rightToes",
];
const CONTACT_INDICES = [3, 4, 7, 8];
const SAMPLE_HZ = 60;
const MAX_HORIZONTAL_ERROR = 0.01;
const MAX_HEIGHT_ERROR = 0.005;
const MAX_CONTACT_SPEED = 0.04;
const MAX_FADE_SEC = 2;

interface LowerPose {
  rotations: THREE.Quaternion[];
  hips: THREE.Vector3;
}
interface PreparedBase {
  clip: THREE.AnimationClip;
  upper: THREE.KeyframeTrack[];
  lower: THREE.KeyframeTrack[];
  positions: THREE.KeyframeTrack;
  rotations: THREE.Interpolant[];
  translation: THREE.Interpolant;
  upperChannels: Map<string, THREE.Interpolant>;
}
interface Ramp {
  from: number;
  to: number;
  start: number;
  duration: number;
}
interface Group {
  id: number;
  prepared: PreparedBase;
  upper: THREE.AnimationAction;
  lower: THREE.AnimationAction;
  start: number;
  end: number;
  phase: number;
  startedAt: number;
  held: boolean;
  paused: boolean;
  blend: number;
  blendRamp?: Ramp;
  upperGain: number;
  upperRamp?: Ramp;
  stopAt?: number;
  offset: THREE.Vector3;
  completion: ReturnType<typeof deferred>;
  stopped: ReturnType<typeof deferred>;
}

/**
 * A finite recorded performance owns two disjoint bindings on the same mixer.
 * One clock drives both actions; semantic gestures only duck the upper bindings.
 * The private lower skeleton validates alignment and the actual slerp fade path.
 * No loop repair, live skeleton sampling mutations, root Y offsets or IK occur.
 */
export class RecordedBasePlayer {
  private readonly prepared = new WeakMap<THREE.AnimationClip, PreparedBase>();
  private readonly groups = new Map<number, Group>();
  private readonly liveBones: THREE.Object3D[];
  private readonly bones: THREE.Object3D[];
  private readonly root: THREE.Object3D;
  private readonly names = new Map<string, number>();
  private readonly rest: LowerPose;
  private nextId = 1;

  constructor(
    private readonly mixer: THREE.AnimationMixer,
    vrm: VRM,
  ) {
    const humanoid = vrm.humanoid;
    const hips = humanoid?.getNormalizedBoneNode("hips");
    if (!hips?.parent) throw new Error("Recorded base requires a normalized lower skeleton");
    this.root = new THREE.Object3D();
    const copies = new Map<THREE.Object3D, THREE.Object3D>([[hips.parent, this.root]]);
    const copyPath = (live: THREE.Object3D): THREE.Object3D => {
      const existing = copies.get(live);
      if (existing) return existing;
      if (!live.parent || copies.size >= 32) throw new Error("Unsupported recorded base skeleton");
      const copy = new THREE.Object3D();
      copy.position.copy(live.position);
      copy.quaternion.copy(live.quaternion);
      copy.scale.copy(live.scale);
      copies.set(live, copy);
      copyPath(live.parent).add(copy);
      return copy;
    };
    this.liveBones = LOWER_NAMES.map((name) => {
      const bone = humanoid.getNormalizedBoneNode(name);
      if (!bone) throw new Error(`Recorded base requires ${name}`);
      return bone;
    });
    this.bones = this.liveBones.map((live, index) => {
      const rest = humanoid.normalizedRestPose[LOWER_NAMES[index]];
      if (!rest?.position?.every(Number.isFinite) || !rest.rotation?.every(Number.isFinite))
        throw new Error("Recorded base requires a finite normalized rest pose");
      if (Math.hypot(...rest.rotation) < 1e-8)
        throw new Error("Recorded base requires nonzero rest rotations");
      const copy = copyPath(live);
      copy.position.fromArray(rest.position);
      copy.quaternion.fromArray(rest.rotation).normalize();
      if (live.name) this.names.set(`${live.name}.quaternion`, index);
      this.names.set(`${live.uuid}.quaternion`, index);
      return copy;
    });
    this.rest = {
      hips: this.bones[0].position.clone(),
      rotations: this.bones.map((bone) => bone.quaternion.clone()),
    };
    for (const copy of copies.values()) {
      if (
        ![...copy.position, ...copy.quaternion, ...copy.scale].every(Number.isFinite) ||
        Math.min(...copy.scale.toArray().map(Math.abs)) < 1e-8
      )
        throw new Error("Recorded base requires a finite nondegenerate skeleton");
    }
  }

  prepare(clip: THREE.AnimationClip): PreparedBase {
    const cached = this.prepared.get(clip);
    if (cached) return cached;
    if (
      !Number.isFinite(clip.duration) ||
      clip.duration <= 0 ||
      clip.duration > 120 ||
      clip.tracks.length > 64
    )
      throw new Error("Unsupported recorded base duration or track count");
    const upper: THREE.KeyframeTrack[] = [],
      lower: THREE.KeyframeTrack[] = [];
    const rotations: THREE.Interpolant[] = [];
    let positions: THREE.KeyframeTrack | undefined;
    const hips = this.liveBones[0];
    for (const track of clip.tracks) {
      if (
        track.times.length < 2 ||
        track.times.length > 20_000 ||
        !track.values.every(Number.isFinite) ||
        !track.times.every(
          (time, index, times) =>
            Number.isFinite(time) &&
            time >= 0 &&
            time <= clip.duration + 1e-5 &&
            (index === 0 || time > times[index - 1]),
        )
      )
        throw new Error("Invalid recorded base track samples");
      if (track.name === `${hips.name}.position` || track.name === `${hips.uuid}.position`) {
        if (positions || track.getValueSize() !== 3)
          throw new Error("Invalid recorded base hips translation");
        positions = track;
        lower.push(track);
      } else if (track.ValueTypeName === "quaternion" && track.getValueSize() === 4) {
        for (let index = 0; index < track.values.length; index += 4)
          if (
            Math.abs(
              Math.hypot(
                track.values[index],
                track.values[index + 1],
                track.values[index + 2],
                track.values[index + 3],
              ) - 1,
            ) > 1e-3
          )
            throw new Error("Invalid recorded base rotation");
        const bone = this.names.get(track.name);
        if (bone === undefined) upper.push(track);
        else {
          if (rotations[bone]) throw new Error("Duplicate recorded base bone");
          rotations[bone] = interpolant(track);
          lower.push(track);
        }
      } else throw new Error("Recorded base supports only humanoid rotations and hips XYZ");
    }
    if (!positions || upper.length === 0 || LOWER_NAMES.some((_, index) => !rotations[index]))
      throw new Error("Recorded base requires complete lower motion and an upper performance");
    const result = {
      clip,
      upper,
      lower,
      positions,
      rotations,
      translation: interpolant(positions),
      upperChannels: new Map(upper.map((track) => [track.name, interpolant(track)])),
    };
    this.prepared.set(clip, result);
    return result;
  }

  play(clip: THREE.AnimationClip, opts: RecordedBaseOptions): RecordedBaseHandle {
    const prepared = this.prepare(clip);
    const start = opts.startTimeSec,
      end = opts.endTimeSec;
    const fade = Math.max(0, Math.min(MAX_FADE_SEC, (opts.fadeInMs ?? 800) / 1000));
    if (
      ![start, end, fade].every(Number.isFinite) ||
      start < 0 ||
      end < start ||
      end > clip.duration + 1e-5
    )
      throw new Error("Invalid recorded base segment");
    const supported = (time: number) =>
      opts.contactWindows.some(
        (window) =>
          window.feet === "both" &&
          Number.isFinite(window.startTimeSec) &&
          Number.isFinite(window.endTimeSec) &&
          window.startTimeSec <= time &&
          time <= window.endTimeSec,
      );
    const fadeEnd = Math.min(end, start + fade);
    const continuousSupport = opts.contactWindows.some(
      (window) =>
        window.feet === "both" &&
        Number.isFinite(window.startTimeSec) &&
        Number.isFinite(window.endTimeSec) &&
        window.startTimeSec <= start &&
        window.endTimeSec >= fadeEnd,
    );
    if (!continuousSupport || !supported(end))
      throw new Error("Recorded base boundaries and fade require reviewed both-foot support");
    let previous: Group | undefined;
    for (const group of this.groups.values()) {
      if (group.stopAt !== undefined)
        throw new Error("Recorded base transition is already in progress");
      previous = group;
    }
    if (previous && !previous.held)
      throw new Error("Recorded base replacement requires a held safe exit");
    if (opts.initialPose && (previous || fade !== 0))
      throw new Error("Recorded base initial pose requires an empty group and zero fade");
    const outgoing = previous
      ? this.sample(previous.prepared, previous.phase, previous.offset)
      : this.livePose();
    const anchors = this.contacts(outgoing);
    const incoming = this.sample(prepared, start);
    const incomingPoints = this.contacts(incoming);
    const offset = new THREE.Vector3();
    // Initial placement uses the avatar's normal footprint center, while
    // replacements inherit the held recording's anchor. Both are constant XZ
    // translations: source stance width, facing, Y and motion deltas survive.
    const placement = opts.initialPose ? this.contacts(this.rest) : anchors;
    for (let index = 0; index < placement.length; index++)
      offset.add(placement[index]).sub(incomingPoints[index]);
    offset.multiplyScalar(1 / placement.length);
    offset.y = 0;
    this.assertBoundary(prepared, start, offset, opts.initialPose ? undefined : anchors);
    this.assertBoundary(prepared, end, offset);
    // Endpoint agreement cannot exclude a bent-leg slerp dipping into the floor.
    // Validate the exact normalized-pose interpolation throughout the short fade.
    const steps = Math.max(1, Math.ceil(fade * SAMPLE_HZ));
    for (let frame = 0; !opts.initialPose && frame <= steps; frame++) {
      const fraction = frame / steps;
      const phase = Math.min(end, start + fade * fraction);
      if (!supported(phase))
        throw new Error("Recorded base fade crosses an unreviewed contact gap");
      const target = this.sample(prepared, phase, offset);
      const blend = smooth(fraction);
      target.hips.lerpVectors(outgoing.hips, target.hips, blend);
      target.rotations.forEach((rotation, index) => {
        // slerpQuaternions(a, this, t) overwrites its second input in Three.
        // Reverse the interpolation instead so the sampled target stays intact.
        rotation.slerp(outgoing.rotations[index], 1 - blend);
      });
      this.assertContacts(this.contacts(target), anchors);
      if (!previous && opts.onCommit) {
        // Cancelling the old standing foundation restores its original rest.
        // Check that exact first-fade origin before asking the caller to retire it.
        const fromRest = this.sample(prepared, phase, offset);
        fromRest.hips.lerpVectors(this.rest.hips, fromRest.hips, blend);
        fromRest.rotations.forEach((rotation, index) => {
          rotation.slerp(this.rest.rotations[index], 1 - blend);
        });
        this.assertContacts(this.contacts(fromRest), anchors);
      }
    }
    const shifted = prepared.positions.clone();
    shifted.values = prepared.positions.values.slice();
    for (let index = 0; index < shifted.values.length; index += 3) {
      shifted.values[index] += offset.x;
      shifted.values[index + 2] += offset.z;
    }
    const lowerTracks = prepared.lower.map((track) =>
      track === prepared.positions ? shifted : track,
    );
    opts.onCommit?.();
    const initialState = opts.getInitialState?.();
    const upper = this.action(
      new THREE.AnimationClip(`${clip.name}:recorded-upper`, clip.duration, prepared.upper),
      start,
    );
    const lower = this.action(
      new THREE.AnimationClip(`${clip.name}:recorded-lower`, clip.duration, lowerTracks),
      start,
    );
    const group: Group = {
      id: this.nextId++,
      prepared,
      upper,
      lower,
      start,
      end,
      phase: start,
      startedAt: this.mixer.time,
      held: start === end,
      paused: initialState?.paused ?? false,
      blend: fade ? 0 : 1,
      blendRamp: fade ? { from: 0, to: 1, start: this.mixer.time, duration: fade } : undefined,
      upperGain: clampWeight(initialState?.upperWeight ?? 1),
      offset,
      completion: deferred(),
      stopped: deferred(),
    };
    // Activate both bindings before releasing any previous group's restore state.
    upper.setEffectiveWeight(0).play();
    lower.setEffectiveWeight(group.blend).play();
    this.groups.set(group.id, group);
    if (previous) this.stopGroup(previous, fade * 1000);
    if (group.held) group.completion.resolve();
    return {
      id: group.id,
      get phaseSec() {
        return group.phase;
      },
      get held() {
        return group.held;
      },
      get paused() {
        return group.paused;
      },
      completion: group.completion.promise,
      setPaused: (paused) => {
        if (this.groups.has(group.id)) group.paused = paused;
      },
      setUpperWeight: (value, fadeMs = 0) => {
        if (!this.groups.has(group.id)) return;
        const to = clampWeight(value);
        const duration = Number.isFinite(fadeMs) ? Math.max(0, fadeMs / 1000) : 0;
        group.upperRamp = duration
          ? { from: group.upperGain, to, start: this.mixer.time, duration }
          : undefined;
        if (!duration) group.upperGain = to;
      },
      stop: (fadeMs = 200) => {
        this.stopGroup(group, fadeMs);
        return group.stopped.promise;
      },
      cancel: () => this.disposeGroup(group),
    };
  }

  /** Set both phases/weights before the shared mixer's one evaluation. */
  beforeUpdate(nextTime: number, performanceWeight: number): void {
    const complement = 1 - Math.max(0, Math.min(1, performanceWeight));
    for (const group of this.groups.values()) {
      if (group.paused) group.startedAt += Math.max(0, nextTime - this.mixer.time);
      if (!group.paused && !group.held && group.stopAt === undefined) {
        group.phase = Math.min(group.end, group.start + Math.max(0, nextTime - group.startedAt));
        group.held = group.phase >= group.end - 1e-9;
        if (group.held) group.phase = group.end;
      }
      if (group.blendRamp) {
        group.blend = rampValue(group.blendRamp, nextTime);
        if (nextTime >= group.blendRamp.start + group.blendRamp.duration)
          group.blendRamp = undefined;
      }
      if (group.upperRamp) {
        group.upperGain = rampValue(group.upperRamp, nextTime);
        if (nextTime >= group.upperRamp.start + group.upperRamp.duration)
          group.upperRamp = undefined;
      }
      group.upper.time = group.phase;
      group.lower.time = group.phase;
      group.upper.setEffectiveWeight(group.blend * group.upperGain * complement);
      group.lower.setEffectiveWeight(group.blend);
    }
  }

  afterUpdate(): void {
    for (const group of this.groups.values()) {
      if (group.held) group.completion.resolve();
      if (group.stopAt !== undefined && this.mixer.time >= group.stopAt - 1e-9)
        this.disposeGroup(group);
    }
  }
  stopAll(fadeMs = 0): void {
    for (const group of this.groups.values()) this.stopGroup(group, fadeMs);
  }
  retireFadingActions(): void {
    for (const group of this.groups.values())
      if (group.stopAt !== undefined) this.disposeGroup(group);
  }
  get upperWeight(): number {
    let sum = 0;
    for (const group of this.groups.values()) sum += group.upper.getEffectiveWeight();
    return Math.min(1, sum);
  }
  get lowerWeight(): number {
    let sum = 0;
    for (const group of this.groups.values()) sum += group.lower.getEffectiveWeight();
    return Math.min(1, sum);
  }
  get activeCount(): number {
    return this.groups.size * 2;
  }

  /** Paused supports still own their bindings, but do not need the animation frame cadence. */
  get hasMotion(): boolean {
    for (const group of this.groups.values())
      if (
        (!group.paused && !group.held && group.stopAt === undefined) ||
        group.blendRamp ||
        group.upperRamp ||
        group.stopAt !== undefined
      )
        return true;
    return false;
  }

  hasUpperBinding(name: string): boolean {
    for (const group of this.groups.values())
      if (group.prepared.upperChannels.has(name)) return true;
    return false;
  }

  /** Decision-time reference for the existing physical matcher, not a per-frame allocation. */
  transitionPose(
    source: ReadonlyMap<string, MotionPoseJoint>,
  ): ReadonlyMap<string, MotionPoseJoint> {
    if (!this.groups.size) return source;
    const result = new Map(source);
    const mixed = new THREE.Quaternion(),
      rotation = new THREE.Quaternion(),
      rest = new THREE.Quaternion();
    for (const [name, joint] of source) {
      let weight = 0;
      let referenceMoving = false;
      for (const group of this.groups.values()) {
        const channel = group.prepared.upperChannels.get(name);
        const contribution = group.blend * group.upperGain;
        if (!channel || contribution <= 0) continue;
        referenceMoving ||=
          (!group.paused && !group.held) ||
          group.blendRamp !== undefined ||
          group.upperRamp !== undefined;
        rotation.fromArray(channel.evaluate(group.phase)).normalize();
        if (weight === 0) mixed.copy(rotation);
        else mixed.slerp(rotation, contribution / (weight + contribution));
        weight += contribution;
      }
      if (weight === 0) continue;
      rest.fromArray(joint.restPose).normalize().slerp(mixed, Math.min(1, weight));
      result.set(name, {
        ...joint,
        restPose: new Float32Array(rest.toArray()),
        // The existing matcher assumes a stationary background for its velocity
        // prediction. Use its pose gate while this reference moves, instead of
        // incorrectly treating the continuing recorded velocity as a mismatch.
        velocityValid: joint.velocityValid && !referenceMoving,
      });
    }
    return result;
  }

  private action(clip: THREE.AnimationClip, time: number): THREE.AnimationAction {
    const action = this.mixer.clipAction(clip);
    action.reset().setLoop(THREE.LoopOnce, 1).setEffectiveTimeScale(1);
    action.clampWhenFinished = true;
    // Group clock drives action.time directly, including an exact finite hold.
    action.paused = true;
    action.time = time;
    return action;
  }
  private stopGroup(group: Group, fadeMs: number): void {
    if (!this.groups.has(group.id)) return;
    const duration = Number.isFinite(fadeMs) ? Math.max(0, fadeMs / 1000) : 0;
    if (!duration) {
      this.disposeGroup(group);
      return;
    }
    const deadline = this.mixer.time + duration;
    if (group.stopAt !== undefined && group.stopAt <= deadline) return;
    group.stopAt = deadline;
    group.blendRamp = { from: group.blend, to: 0, start: this.mixer.time, duration };
  }
  private disposeGroup(group: Group): void {
    if (!this.groups.delete(group.id)) return;
    for (const action of [group.upper, group.lower]) {
      action.stop();
      this.mixer.uncacheClip(action.getClip());
    }
    group.completion.resolve();
    group.stopped.resolve();
  }
  private livePose(): LowerPose {
    return {
      hips: this.liveBones[0].position.clone(),
      rotations: this.liveBones.map((bone) => bone.quaternion.clone()),
    };
  }
  private sample(prepared: PreparedBase, phase: number, offset?: THREE.Vector3): LowerPose {
    const hips = new THREE.Vector3().fromArray(prepared.translation.evaluate(phase));
    if (offset) hips.add(offset);
    return {
      hips,
      rotations: prepared.rotations.map((track) =>
        new THREE.Quaternion().fromArray(track.evaluate(phase)).normalize(),
      ),
    };
  }
  private contacts(pose: LowerPose): THREE.Vector3[] {
    this.bones[0].position.copy(pose.hips);
    this.bones.forEach((bone, index) => {
      bone.quaternion.copy(pose.rotations[index]);
    });
    this.root.updateMatrixWorld(true);
    return CONTACT_INDICES.map((index) => this.bones[index].getWorldPosition(new THREE.Vector3()));
  }
  private assertContacts(points: THREE.Vector3[], anchors: THREE.Vector3[]): void {
    for (let index = 0; index < points.length; index++) {
      const point = points[index],
        anchor = anchors[index];
      if (
        !point.toArray().every(Number.isFinite) ||
        Math.hypot(point.x - anchor.x, point.z - anchor.z) > MAX_HORIZONTAL_ERROR ||
        Math.abs(point.y - anchor.y) > MAX_HEIGHT_ERROR
      )
        throw new Error("Recorded base contact alignment or fade exceeds target foot limits");
    }
  }
  private assertBoundary(
    prepared: PreparedBase,
    phase: number,
    offset: THREE.Vector3,
    anchors?: THREE.Vector3[],
  ): void {
    const points = this.contacts(this.sample(prepared, phase, offset));
    this.assertContacts(points, points);
    if (anchors) this.assertContacts(points, anchors);
    const before = Math.max(0, phase - 1 / SAMPLE_HZ),
      after = Math.min(prepared.clip.duration, phase + 1 / SAMPLE_HZ);
    const previous = this.contacts(this.sample(prepared, before, offset));
    const next = this.contacts(this.sample(prepared, after, offset));
    for (let index = 0; index < points.length; index++)
      if (next[index].distanceTo(previous[index]) / (after - before) > MAX_CONTACT_SPEED)
        throw new Error("Recorded base boundary feet are moving too quickly to hold or transition");
  }
}

function interpolant(track: THREE.KeyframeTrack): THREE.Interpolant {
  return (
    track as THREE.KeyframeTrack & { createInterpolant(result: Float32Array): THREE.Interpolant }
  ).createInterpolant(new Float32Array(track.getValueSize()));
}
function clampWeight(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
function smooth(value: number): number {
  return value * value * (3 - 2 * value);
}
function rampValue(ramp: Ramp, time: number): number {
  const progress = Math.max(0, Math.min(1, (time - ramp.start) / ramp.duration));
  return ramp.from + (ramp.to - ramp.from) * smooth(progress);
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

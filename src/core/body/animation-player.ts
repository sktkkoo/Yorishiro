/**
 * VRMA playback primitive. The scheduler owns priority; this layer owns clip
 * preparation, phase-compatible transitions, and the lifetime of mixer actions.
 * Analysis runs once per retargeted clip. update() does no feature allocation.
 */
import { type VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import {
  createVRMAnimationClip,
  type VRMAnimation,
  VRMAnimationLoaderPlugin,
} from "@pixiv/three-vrm-animation";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { SubsystemLog } from "../dev-log";
import {
  analyzeMotionClip,
  conditionMotionLoop,
  findMatchedEntry,
  findTransitionDelay,
  type MotionPoseJoint,
  type MotionTransitionProfile,
  measureMotionEntry,
  UPPER_BODY_TRANSITION_LIMITS,
} from "./motion-transition";
import { calibrateStandingIdleClip, groundStandingIdleClip } from "./standing-idle-grounding";

const ANIM_ALIAS: Record<string, string> = {
  VRMA_small_nod: "Thankful",
  VRMA_head_tilt_down: "Leaning",
  VRMA_small_recoil: "Angry",
  VRMA_idle_sway: "Idle",
  VRMA_still: "VRMA_01_TurnMotion",
  VRMA_gun_fire: "VRMA_04_GunFire",
};

export interface AnimationPlayOptions {
  fadeInMs?: number;
  fadeOutMs?: number;
  weight?: number;
  loop?: boolean;
  speed?: number;
  /** Only matched idle motifs may enter in the middle of a clip. */
  transition?: "matched" | "immediate";
  mask?: "upper-body" | "lower-body" | "full-body";
  /** Preserve reviewed hips XYZ only for full-body, immediate, non-looping performances. */
  rootMotion?: "in-place" | "preserve";
  /** Internal mixer ownership. Public motion requests remain on the performance layer. */
  layer?: "foundation" | "performance";
  /** Explicit phase override for deterministic visual comparisons. */
  startTimeSec?: number;
  /** Upper bound on waiting for a quieter outgoing pose (default: 180 ms). */
  maxTransitionDelayMs?: number;
  /** Cap long one-shots at a quiet exit within another 500 ms; looping recordings ignore this. */
  maxDurationMs?: number;
  /** Checked after loading and after transition waits. False rejects with AbortError. */
  isCurrent?: () => boolean;
}

interface WeightRamp {
  from: number;
  to: number;
  start: number;
  duration: number;
}
interface ActiveAnimation {
  readonly id: number;
  readonly ref: string;
  readonly action: THREE.AnimationAction;
  readonly layer: "foundation" | "performance";
  readonly profile: MotionTransitionProfile;
  readonly loop: boolean;
  readonly autoFadeOutMs: number;
  readonly completion: ReturnType<typeof createDeferred>;
  readonly stopped: ReturnType<typeof createDeferred>;
  ramp?: WeightRamp;
  stopAt?: number;
  maxDurationAt?: number;
}
interface TransitionWait {
  readonly until: number;
  readonly isCurrent: () => boolean;
  readonly resolve: () => void;
}

interface PoseSnapshotBinding {
  readonly node: THREE.Object3D;
  readonly sample: MotionPoseJoint;
}

const DEFAULT_AUTO_FADE_OUT_MS = 400;
const LOWER_BODY_BONES: ReadonlySet<string> = new Set([
  "hips",
  "leftUpperLeg",
  "rightUpperLeg",
  "leftLowerLeg",
  "rightLowerLeg",
  "leftFoot",
  "rightFoot",
  "leftToes",
  "rightToes",
]);
let nextAnimId = 1;

export class AnimationPlayer {
  private readonly mixer: THREE.AnimationMixer;
  private readonly vrm: VRM;
  private readonly loader: GLTFLoader;
  private readonly clipCache = new Map<string, THREE.AnimationClip>();
  private readonly pendingLoads = new Map<string, Promise<THREE.AnimationClip | null>>();
  private readonly sourceAnimations = new Map<string, VRMAnimation>();
  private readonly pendingSources = new Map<string, Promise<VRMAnimation | null>>();
  private readonly maskedClips = new WeakMap<
    THREE.AnimationClip,
    Map<NonNullable<AnimationPlayOptions["mask"]>, THREE.AnimationClip>
  >();
  private readonly loopClips = new WeakMap<THREE.AnimationClip, THREE.AnimationClip>();
  private readonly standingClips = new WeakMap<THREE.AnimationClip, THREE.AnimationClip>();
  private readonly groundedClips = new WeakMap<THREE.AnimationClip, THREE.AnimationClip>();
  private readonly profiles = new WeakMap<THREE.AnimationClip, MotionTransitionProfile>();
  private readonly preparedProfiles = new Map<string, MotionTransitionProfile>();
  private readonly poseSnapshot = new Map<string, MotionPoseJoint>();
  private readonly poseBindings: PoseSnapshotBinding[] = [];
  private readonly snapshotPrevious = new THREE.Quaternion();
  private readonly snapshotCurrent = new THREE.Quaternion();
  private readonly snapshotDelta = new THREE.Quaternion();
  private hasPoseSample = false;
  private readonly active = new Map<number, ActiveAnimation>();
  private readonly transitionWaits = new Set<TransitionWait>();
  private readonly devLog?: SubsystemLog;
  private readonly beforeActionPlay?: () => void;
  private generation = 0;

  constructor(vrm: VRM, devLog?: SubsystemLog, beforeActionPlay?: () => void) {
    this.vrm = vrm;
    this.devLog = devLog;
    this.beforeActionPlay = beforeActionPlay;
    const nodes = new Set<THREE.Object3D>();
    if (vrm.humanoid) {
      for (const name of Object.values(VRMHumanBoneName)) {
        if (LOWER_BODY_BONES.has(name)) continue;
        const node = vrm.humanoid.getNormalizedBoneNode(name);
        if (node) nodes.add(node);
      }
    } else vrm.scene.traverse((node) => nodes.add(node));
    for (const node of nodes) {
      const pose = new Float32Array(node.quaternion.toArray());
      const sample: MotionPoseJoint = {
        pose,
        restPose: pose.slice(),
        velocity: new Float32Array(3),
        velocityValid: false,
      };
      this.poseBindings.push({ node, sample });
      if (node.name) this.poseSnapshot.set(`${node.name}.quaternion`, sample);
      this.poseSnapshot.set(`${node.uuid}.quaternion`, sample);
    }
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.loader = new GLTFLoader();
    this.loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    this.mixer.addEventListener("finished", (event) => {
      for (const anim of this.active.values()) {
        if (anim.action !== event.action) continue;
        anim.completion.resolve();
        // Do not extend a fade already requested by a replacement or stop().
        if (anim.stopAt === undefined) this.fadeAndStop(anim, anim.autoFadeOutMs);
        break;
      }
    });
  }

  /** Fade deadlines use animation time; pausing rendering cannot leave ghost actions. */
  update(delta: number): void {
    if (!Number.isFinite(delta) || delta < 0) return;
    const time = this.mixer.time + delta;
    for (const anim of this.active.values()) this.updateWeight(anim, time);
    this.mixer.update(delta);
    this.captureMixedPose(delta);
    for (const anim of this.active.values()) {
      if (anim.maxDurationAt !== undefined && this.mixer.time >= anim.maxDurationAt) {
        anim.maxDurationAt = undefined;
        // Completion follows natural one-shots: release ownership as the final
        // fade begins. An earlier replacement/stop already owns its deadline.
        if (anim.stopAt === undefined) {
          anim.completion.resolve();
          this.fadeAndStop(anim, anim.autoFadeOutMs);
        }
      }
      if (anim.stopAt !== undefined && this.mixer.time >= anim.stopAt) this.disposeAnimation(anim);
    }
    for (const wait of this.transitionWaits) {
      if (!wait.isCurrent() || this.mixer.time >= wait.until) {
        this.transitionWaits.delete(wait);
        wait.resolve();
      }
    }
  }

  /** Load, retarget, mask and analyze before a scheduler commits to a replacement. */
  async preload(
    ref: string,
    opts: Pick<
      AnimationPlayOptions,
      "mask" | "loop" | "isCurrent" | "rootMotion" | "transition" | "layer"
    > = {},
  ): Promise<boolean> {
    try {
      this.assertRootMotionOptions(opts);
      const clip = await this.loadClip(ref, opts.rootMotion);
      if (opts.isCurrent && !opts.isCurrent()) return false;
      if (!clip) return false;
      this.prepareClip(clip, opts.mask, opts.loop, ref, opts.rootMotion);
      return true;
    } catch {
      // Invalid root preservation or standing preparation must fail closed.
      // The caller can retain its existing pose when a reviewed variant is unavailable.
      return false;
    }
  }

  /** No loading, preparation or live pose mutation on the director's decision path. */
  evaluateTransition(
    ref: string,
    opts: Pick<AnimationPlayOptions, "mask" | "loop" | "weight" | "speed" | "transition">,
  ): { cost: number; startTimeSec: number } | null {
    if (opts.mask !== "upper-body") return null;
    const profile = this.preparedProfiles.get(this.profileKey(ref, opts.mask, opts.loop));
    if (!profile) return null;
    const result = measureMotionEntry(
      this.poseSnapshot,
      profile,
      {
        weight: opts.weight ?? 0.7,
        speed: opts.speed ?? 1,
        matched: opts.transition === "matched",
        loop: opts.loop ?? false,
      },
      UPPER_BODY_TRANSITION_LIMITS,
    );
    // Local continuity rejection limits, calibrated against the installed Yori
    // catalog. They are not a perceptual score or a full-body contact guarantee.
    if (!result) return null;
    return { cost: result.cost, startTimeSec: result.startTimeSec };
  }

  async play(ref: string, opts: AnimationPlayOptions = {}) {
    this.assertRootMotionOptions(opts);
    const generation = this.generation;
    const isCurrent = () => generation === this.generation && (opts.isCurrent?.() ?? true);
    const loadedClip = await this.loadClip(ref, opts.rootMotion);
    this.assertCurrent(isCurrent);
    if (!loadedClip) throw new Error(`animation not found: ${ref}`);
    const { clip, profile } = this.prepareClip(
      loadedClip,
      opts.mask,
      opts.loop,
      ref,
      opts.rootMotion,
    );
    const layer = opts.layer ?? "performance";
    let previous = this.latestAnimation(layer);
    if (previous && opts.transition === "matched" && opts.startTimeSec === undefined) {
      const delay = findTransitionDelay(
        previous.profile,
        previous.action.time,
        Math.min(0.5, Math.max(0, (opts.maxTransitionDelayMs ?? 180) / 1000)),
        previous.action.getEffectiveTimeScale(),
        previous.loop,
      );
      if (delay > 0) {
        await new Promise<void>((resolve) => {
          this.transitionWaits.add({ until: this.mixer.time + delay, isCurrent, resolve });
        });
        this.assertCurrent(isCurrent);
        previous = this.latestAnimation(layer);
      }
    }
    // A fresh action identity lets the same clip replay while its old action fades.
    // Share immutable tracks; clone only the clip wrapper, not all keyframes.
    const playbackClip = new THREE.AnimationClip(
      clip.name,
      clip.duration,
      clip.tracks,
      clip.blendMode,
    );
    const action = this.mixer.clipAction(playbackClip);
    const id = nextAnimId++;
    const speed = finiteOr(opts.speed, 1);
    action.reset();
    action.setLoop(opts.loop ? THREE.LoopRepeat : THREE.LoopOnce, opts.loop ? Infinity : 1);
    action.clampWhenFinished = !opts.loop;
    action.setEffectiveTimeScale(speed);
    action.time = Math.max(
      0,
      Math.min(
        clip.duration,
        opts.startTimeSec ??
          (previous && opts.transition === "matched"
            ? findMatchedEntry(previous.profile, previous.action.time, profile, {
                sourceSpeed: previous.action.getEffectiveTimeScale(),
                targetSpeed: speed,
                loop: opts.loop,
              })
            : 0),
      ),
    );
    const weight = clampWeight(opts.weight ?? 0.7);
    const fadeSec = Math.max(0, finiteOr(opts.fadeInMs, 200)) / 1000;
    const anim: ActiveAnimation = {
      id,
      ref,
      action,
      layer,
      profile,
      loop: opts.loop ?? false,
      autoFadeOutMs: Math.max(0, finiteOr(opts.fadeOutMs, DEFAULT_AUTO_FADE_OUT_MS)),
      completion: createDeferred(),
      stopped: createDeferred(),
    };
    const capSec = finiteOr(opts.maxDurationMs, 0) / 1000;
    const remainingSec = speed > 0 ? (clip.duration - action.time) / speed : Infinity;
    if (!anim.loop && capSec > 0 && capSec < remainingSec) {
      const capPhase = action.time + capSec * speed;
      const exitDelay = findTransitionDelay(profile, capPhase, 0.5, speed, false);
      anim.maxDurationAt = this.mixer.time + capSec + exitDelay;
    }
    action.setEffectiveWeight(fadeSec > 0 ? 0 : weight);
    if (fadeSec > 0) anim.ramp = { from: 0, to: weight, start: this.mixer.time, duration: fadeSec };
    // Clear procedural offsets before Three captures its restoration pose.
    this.beforeActionPlay?.();
    // Three captures its original binding value only when the first action
    // activates it. Keep the same rest reference for weighted pose comparison.
    for (const joint of profile.joints) {
      const sample = this.poseSnapshot.get(joint.name);
      if (!sample) continue;
      const alreadyBound = [...this.active.values()].some((outgoing) =>
        outgoing.profile.joints.some((other) => this.poseSnapshot.get(other.name) === sample),
      );
      if (!alreadyBound) {
        const binding = this.poseBindings.find((item) => item.sample === sample);
        binding?.node.quaternion.toArray(sample.restPose);
      }
    }
    // Activate incoming bindings before retiring a zero-fade action.
    action.play();
    for (const outgoing of this.active.values()) {
      if (outgoing.layer === layer) this.fadeAndStop(outgoing, fadeSec * 1000);
    }
    this.active.set(id, anim);
    this.devLog?.write({
      phase: "transition",
      note: `play ${ref}`,
      data: {
        from: previous?.ref ?? null,
        entrySec: action.time,
        transition: opts.transition ?? "immediate",
        mask: opts.mask ?? "full-body",
        rootMotion: opts.rootMotion ?? "in-place",
        layer,
        grounded:
          layer === "foundation" && clip.tracks.some((track) => track.name.endsWith(".position")),
        fadeSec,
      },
    });
    return {
      id,
      completion: anim.completion.promise,
      setWeight: (value: number, fadeMs = 0) => {
        if (!this.active.has(id)) return;
        const to = clampWeight(value);
        if (fadeMs > 0)
          anim.ramp = {
            from: action.getEffectiveWeight(),
            to,
            start: this.mixer.time,
            duration: fadeMs / 1000,
          };
        else {
          anim.ramp = undefined;
          action.setEffectiveWeight(to);
        }
      },
      stop: (fadeMs = 200): Promise<void> => {
        if (this.active.has(id)) this.fadeAndStop(anim, fadeMs);
        return anim.stopped.promise;
      },
      cancel: () => this.disposeAnimation(anim),
    };
  }

  /** Invalidate pending plays; keep fading actions tracked until they really stop. */
  stopAll(fadeMs = 0): void {
    this.generation++;
    for (const wait of this.transitionWaits) wait.resolve();
    this.transitionWaits.clear();
    for (const anim of this.active.values()) this.fadeAndStop(anim, fadeMs);
  }

  /** Discard outgoing tails before a pose owner freezes the mixer clock. */
  retireFadingActions(): void {
    for (const anim of this.active.values()) {
      if (anim.stopAt !== undefined) this.disposeAnimation(anim);
    }
  }

  get activeCount(): number {
    return this.active.size;
  }
  getTotalEffectiveWeight(): number {
    return this.getLayerEffectiveWeight("performance");
  }

  /** Lower-body contribution, separate from upper-body procedural attenuation. */
  getFoundationEffectiveWeight(): number {
    return this.getLayerEffectiveWeight("foundation");
  }

  private getLayerEffectiveWeight(layer: "foundation" | "performance"): number {
    let total = 0;
    for (const anim of this.active.values()) {
      if (anim.layer !== layer) continue;
      total += anim.action.getEffectiveWeight();
      if (total >= 1) return 1;
    }
    return total;
  }
  private latestAnimation(layer: "foundation" | "performance"): ActiveAnimation | undefined {
    let latest: ActiveAnimation | undefined;
    for (const anim of this.active.values()) {
      if (anim.layer === layer && (!latest || anim.id > latest.id)) latest = anim;
    }
    return latest;
  }
  private captureMixedPose(delta: number): void {
    const reliableDelta = this.hasPoseSample && delta >= 1 / 240 && delta <= 0.1;
    for (const { node, sample } of this.poseBindings) {
      this.snapshotPrevious.fromArray(sample.pose).normalize();
      this.snapshotCurrent.copy(node.quaternion).normalize();
      sample.velocityValid = reliableDelta;
      if (reliableDelta) {
        this.snapshotDelta
          .copy(this.snapshotPrevious)
          .invert()
          .premultiply(this.snapshotCurrent)
          .normalize();
        if (this.snapshotDelta.w < 0) {
          this.snapshotDelta.set(
            -this.snapshotDelta.x,
            -this.snapshotDelta.y,
            -this.snapshotDelta.z,
            -this.snapshotDelta.w,
          );
        }
        const sinHalf = Math.hypot(
          this.snapshotDelta.x,
          this.snapshotDelta.y,
          this.snapshotDelta.z,
        );
        const factor =
          sinHalf > 1e-7 ? (2 * Math.atan2(sinHalf, this.snapshotDelta.w)) / (sinHalf * delta) : 0;
        sample.velocity[0] = this.snapshotDelta.x * factor;
        sample.velocity[1] = this.snapshotDelta.y * factor;
        sample.velocity[2] = this.snapshotDelta.z * factor;
      } else sample.velocity.fill(0);
      this.snapshotCurrent.toArray(sample.pose);
    }
    this.hasPoseSample = true;
  }

  private profileKey(
    ref: string,
    mask: AnimationPlayOptions["mask"],
    loop = false,
    rootMotion: AnimationPlayOptions["rootMotion"] = "in-place",
  ): string {
    return JSON.stringify([ref, mask ?? "full-body", loop, rootMotion]);
  }
  private updateWeight(anim: ActiveAnimation, time: number): void {
    const ramp = anim.ramp;
    if (!ramp) return;
    const t = Math.max(0, Math.min(1, (time - ramp.start) / ramp.duration));
    // Zero endpoint slopes avoid the velocity kick from linear fade weights.
    // Authored timeScale is never warped by unrelated clip durations.
    const eased = t * t * (3 - 2 * t);
    anim.action.setEffectiveWeight(ramp.from + (ramp.to - ramp.from) * eased);
    if (t >= 1) anim.ramp = undefined;
  }
  private fadeAndStop(anim: ActiveAnimation, fadeMs: number): void {
    if (!this.active.has(anim.id)) return;
    const duration = Math.max(0, finiteOr(fadeMs, 0)) / 1000;
    if (duration === 0) {
      this.disposeAnimation(anim);
      return;
    }
    const stopAt = this.mixer.time + duration;
    // Repeated stop requests cannot indefinitely postpone cleanup.
    if (anim.stopAt !== undefined && anim.stopAt <= stopAt) return;
    anim.stopAt = stopAt;
    anim.ramp = { from: anim.action.getEffectiveWeight(), to: 0, start: this.mixer.time, duration };
  }
  private disposeAnimation(anim: ActiveAnimation): void {
    if (this.active.get(anim.id) !== anim) return;
    this.active.delete(anim.id);
    anim.action.stop();
    this.mixer.uncacheClip(anim.action.getClip());
    anim.completion.resolve();
    anim.stopped.resolve();
  }
  private assertCurrent(isCurrent: () => boolean): void {
    if (!isCurrent()) throw new DOMException("Animation request was superseded", "AbortError");
  }
  private prepareClip(
    loaded: THREE.AnimationClip,
    mask: AnimationPlayOptions["mask"],
    loop = false,
    ref?: string,
    rootMotion: AnimationPlayOptions["rootMotion"] = "in-place",
  ) {
    let clip = loaded;
    if (mask === "upper-body" || mask === "lower-body") {
      const cache = this.maskedClips.get(loaded);
      const cached = cache?.get(mask);
      if (cached) clip = cached;
      else {
        const lowerBodyNodes = new Set<string>();
        for (const boneName of Object.values(VRMHumanBoneName)) {
          if (!LOWER_BODY_BONES.has(boneName)) continue;
          const node = this.vrm.humanoid?.getNormalizedBoneNode(boneName);
          if (node) {
            lowerBodyNodes.add(node.name);
            lowerBodyNodes.add(node.uuid);
          }
        }
        clip = new THREE.AnimationClip(
          `${loaded.name}:${mask}`,
          loaded.duration,
          loaded.tracks.filter((track) => {
            const binding = THREE.PropertyBinding.parseTrackName(track.name);
            const lowerBody =
              lowerBodyNodes.has(binding.nodeName) || lowerBodyNodes.has(binding.objectIndex ?? "");
            return mask === "lower-body"
              ? lowerBody && track.name.endsWith(".quaternion")
              : !lowerBody;
          }),
          loaded.blendMode,
        );
        if (cache) cache.set(mask, clip);
        else this.maskedClips.set(loaded, new Map([[mask, clip]]));
      }
    }
    let standingCalibrationApplied = false;
    if (mask === "lower-body" && ref === "anim:Idle") {
      let calibrated = this.standingClips.get(clip);
      if (!calibrated) {
        calibrated = calibrateStandingIdleClip(clip, this.vrm);
        this.standingClips.set(clip, calibrated);
      }
      if (calibrated === clip) throw new Error("Unable to calibrate reviewed standing Idle");
      standingCalibrationApplied = calibrated !== clip;
      clip = calibrated;
    }
    if (loop) {
      const cached = this.loopClips.get(clip);
      if (cached) clip = cached;
      else {
        const conditioned = conditionMotionLoop(clip);
        this.loopClips.set(clip, conditioned);
        clip = conditioned;
      }
    }
    if (standingCalibrationApplied) {
      let grounded = this.groundedClips.get(clip);
      if (!grounded) {
        // Compute compensation after quaternion seam conditioning so the last
        // fraction of the loop uses the same measured foot trajectory too.
        grounded = groundStandingIdleClip(clip, this.vrm);
        this.groundedClips.set(clip, grounded);
      }
      const hips = this.vrm.humanoid.getNormalizedBoneNode("hips");
      const groundingTrack = hips && `${hips.name || hips.uuid}.position`;
      if (
        grounded === clip ||
        !groundingTrack ||
        !grounded.tracks.some(
          (track) => track.name === groundingTrack && track.getValueSize() === 3,
        )
      ) {
        throw new Error("Unable to ground reviewed standing Idle");
      }
      clip = grounded;
    }
    let profile = this.profiles.get(clip);
    if (!profile) {
      const weights = new Map<string, number>();
      for (const boneName of Object.values(VRMHumanBoneName)) {
        const node = this.vrm.humanoid?.getNormalizedBoneNode(boneName);
        if (!node) continue;
        const weight = /Thumb|Index|Middle|Ring|Little/.test(boneName) ? 0.08 : 1;
        weights.set(`${node.name}.quaternion`, weight);
        weights.set(`${node.uuid}.quaternion`, weight);
      }
      profile = analyzeMotionClip(clip, weights);
      this.profiles.set(clip, profile);
    }
    if (ref) this.preparedProfiles.set(this.profileKey(ref, mask, loop, rootMotion), profile);
    return { clip, profile };
  }
  private assertRootMotionOptions(opts: AnimationPlayOptions): void {
    if (opts.rootMotion !== "preserve") return;
    if (
      opts.loop ||
      (opts.mask !== undefined && opts.mask !== "full-body") ||
      opts.layer === "foundation" ||
      opts.transition === "matched"
    ) {
      // Quaternion seam conditioning/matching cannot guarantee root closure or
      // contacts. Reviewed one-shots are the only supported first integration.
      throw new Error(
        "rootMotion preserve requires a full-body, immediate, non-looping performance",
      );
    }
  }
  private async loadClip(
    ref: string,
    rootMotion: AnimationPlayOptions["rootMotion"] = "in-place",
  ): Promise<THREE.AnimationClip | null> {
    const key = rootMotion === "in-place" ? ref : JSON.stringify([ref, rootMotion]);
    const cached = this.clipCache.get(key);
    if (cached) return cached;
    const pending = this.pendingLoads.get(key);
    if (pending) return pending;
    const path = this.resolveRefToPath(ref);
    if (!path) return null;
    const loading = this.fetchClip(ref, path, key, rootMotion);
    this.pendingLoads.set(key, loading);
    try {
      return await loading;
    } finally {
      this.pendingLoads.delete(key);
    }
  }
  private async loadSource(ref: string, path: string): Promise<VRMAnimation | null> {
    const cached = this.sourceAnimations.get(ref);
    if (cached) return cached;
    const pending = this.pendingSources.get(ref);
    if (pending) return pending;
    const loading = this.loader.loadAsync(path).then((gltf) => {
      const animation: VRMAnimation | undefined = gltf.userData.vrmAnimations?.[0];
      if (animation) this.sourceAnimations.set(ref, animation);
      return animation ?? null;
    });
    this.pendingSources.set(ref, loading);
    try {
      return await loading;
    } finally {
      this.pendingSources.delete(ref);
    }
  }
  private async fetchClip(
    ref: string,
    path: string,
    key: string,
    rootMotion: AnimationPlayOptions["rootMotion"],
  ): Promise<THREE.AnimationClip | null> {
    try {
      const source = await this.loadSource(ref, path);
      if (!source) return null;
      const preserve = rootMotion === "preserve";
      const translation = new Map<"hips", THREE.VectorKeyframeTrack>();
      if (preserve) {
        if (
          !source.restHipsPosition.toArray().every(Number.isFinite) ||
          source.restHipsPosition.y < 1e-3
        ) {
          throw new Error("rootMotion preserve requires finite positive source rest hips height");
        }
        const sourceHips = source.humanoidTracks.translation.get("hips");
        validateHipsTranslation(sourceHips, source.duration);
        translation.set("hips", sourceHips);
        const targetHeight = this.vrm.humanoid?.normalizedRestPose?.hips?.position?.[1];
        if (
          !this.vrm.humanoid?.getNormalizedBoneNode("hips")?.name ||
          !Number.isFinite(targetHeight) ||
          (targetHeight ?? 0) < 1e-3
        ) {
          throw new Error("rootMotion preserve requires finite positive target rest hips height");
        }
      }
      // Remove unsupported translations before retargeting. Old converter clips
      // have zero rest hips height; stripping later would first produce NaNs.
      // The parsed source remains immutable so policy variants cannot contaminate each other.
      const animation: VRMAnimation = {
        ...source,
        humanoidTracks: {
          ...source.humanoidTracks,
          translation,
        },
      };
      const clip = createVRMAnimationClip(animation, this.vrm);
      const hips = this.vrm.humanoid?.getNormalizedBoneNode("hips");
      const hipsTrackName = hips && `${hips.name}.position`;
      clip.tracks = clip.tracks.filter(
        (track) =>
          !track.name.endsWith(".scale") &&
          (!track.name.endsWith(".position") || (preserve && track.name === hipsTrackName)),
      );
      if (preserve) {
        validateHipsTranslation(
          clip.tracks.find((track) => track.name === hipsTrackName),
          clip.duration,
        );
      }
      this.prepareClip(clip, "full-body", false, ref, rootMotion);
      this.clipCache.set(key, clip);
      this.devLog?.write({
        phase: "load",
        note: `loaded ${ref}`,
        data: { tracks: clip.tracks.length, durationSec: clip.duration, rootMotion },
      });
      return clip;
    } catch (error) {
      if (rootMotion === "preserve") throw error;
      console.warn(`[AnimationPlayer] failed to load ${path}:`, error);
      return null;
    }
  }
  private resolveRefToPath(ref: string): string | null {
    if (ref.startsWith("anim:")) {
      const name = ref.slice(5);
      return `/animations/${ANIM_ALIAS[name] ?? name}.vrma`;
    }
    return ref.endsWith(".vrma") ? ref : null;
  }
}

function validateHipsTranslation(
  track: THREE.KeyframeTrack | undefined,
  duration: number,
): asserts track is THREE.KeyframeTrack {
  if (
    !track ||
    track.getValueSize() !== 3 ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    track.times.length === 0 ||
    track.values.length !== track.times.length * 3 ||
    !track.values.every(Number.isFinite) ||
    !track.times.every(
      (time, index, times) =>
        Number.isFinite(time) &&
        time >= 0 &&
        time <= duration + 1e-5 &&
        (index === 0 || time > times[index - 1]),
    )
  ) {
    throw new Error("rootMotion preserve requires a finite hips XYZ track with increasing times");
  }
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}
function clampWeight(value: number): number {
  return Math.max(0, Math.min(1, finiteOr(value, 0.7)));
}
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

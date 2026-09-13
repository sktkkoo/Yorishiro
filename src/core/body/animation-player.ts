/**
 * VRMA playback primitive. The scheduler owns priority; this layer owns clip
 * preparation, phase-compatible transitions, and the lifetime of mixer actions.
 * Analysis runs once per retargeted clip. update() does no feature allocation.
 */
import { type VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import { createVRMAnimationClip, VRMAnimationLoaderPlugin } from "@pixiv/three-vrm-animation";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { SubsystemLog } from "../dev-log";
import {
  analyzeMotionClip,
  conditionMotionLoop,
  findMatchedEntry,
  findTransitionDelay,
  type MotionTransitionProfile,
} from "./motion-transition";

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
  mask?: "upper-body" | "full-body";
  /** Explicit phase override for deterministic visual comparisons. */
  startTimeSec?: number;
  /** Upper bound on waiting for a quieter outgoing pose (default: 180 ms). */
  maxTransitionDelayMs?: number;
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
  readonly profile: MotionTransitionProfile;
  readonly loop: boolean;
  readonly autoFadeOutMs: number;
  readonly completion: ReturnType<typeof createDeferred>;
  readonly stopped: ReturnType<typeof createDeferred>;
  ramp?: WeightRamp;
  stopAt?: number;
}
interface TransitionWait {
  readonly until: number;
  readonly isCurrent: () => boolean;
  readonly resolve: () => void;
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
  private readonly maskedClips = new WeakMap<THREE.AnimationClip, THREE.AnimationClip>();
  private readonly loopClips = new WeakMap<THREE.AnimationClip, THREE.AnimationClip>();
  private readonly profiles = new WeakMap<THREE.AnimationClip, MotionTransitionProfile>();
  private readonly active = new Map<number, ActiveAnimation>();
  private readonly transitionWaits = new Set<TransitionWait>();
  private readonly devLog?: SubsystemLog;
  private readonly beforeActionPlay?: () => void;
  private generation = 0;

  constructor(vrm: VRM, devLog?: SubsystemLog, beforeActionPlay?: () => void) {
    this.vrm = vrm;
    this.devLog = devLog;
    this.beforeActionPlay = beforeActionPlay;
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
    for (const anim of this.active.values()) {
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
    opts: Pick<AnimationPlayOptions, "mask" | "loop" | "isCurrent"> = {},
  ): Promise<boolean> {
    const clip = await this.loadClip(ref);
    if (opts.isCurrent && !opts.isCurrent()) return false;
    if (!clip) return false;
    this.prepareClip(clip, opts.mask, opts.loop);
    return true;
  }

  async play(ref: string, opts: AnimationPlayOptions = {}) {
    const generation = this.generation;
    const isCurrent = () => generation === this.generation && (opts.isCurrent?.() ?? true);
    const loadedClip = await this.loadClip(ref);
    this.assertCurrent(isCurrent);
    if (!loadedClip) throw new Error(`animation not found: ${ref}`);
    const { clip, profile } = this.prepareClip(loadedClip, opts.mask, opts.loop);
    let previous = this.latestAnimation();
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
        previous = this.latestAnimation();
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
      profile,
      loop: opts.loop ?? false,
      autoFadeOutMs: Math.max(0, finiteOr(opts.fadeOutMs, DEFAULT_AUTO_FADE_OUT_MS)),
      completion: createDeferred(),
      stopped: createDeferred(),
    };
    action.setEffectiveWeight(fadeSec > 0 ? 0 : weight);
    if (fadeSec > 0) anim.ramp = { from: 0, to: weight, start: this.mixer.time, duration: fadeSec };
    // Clear procedural offsets before Three captures its restoration pose.
    this.beforeActionPlay?.();
    // Activate incoming bindings before retiring a zero-fade action.
    action.play();
    for (const outgoing of this.active.values()) this.fadeAndStop(outgoing, fadeSec * 1000);
    this.active.set(id, anim);
    this.devLog?.write({
      phase: "transition",
      note: `play ${ref}`,
      data: {
        from: previous?.ref ?? null,
        entrySec: action.time,
        transition: opts.transition ?? "immediate",
        mask: opts.mask ?? "full-body",
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
    let total = 0;
    for (const anim of this.active.values()) {
      total += anim.action.getEffectiveWeight();
      if (total >= 1) return 1;
    }
    return total;
  }
  private latestAnimation(): ActiveAnimation | undefined {
    let latest: ActiveAnimation | undefined;
    for (const anim of this.active.values()) if (!latest || anim.id > latest.id) latest = anim;
    return latest;
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
  ) {
    let clip = loaded;
    if (mask === "upper-body") {
      const cached = this.maskedClips.get(loaded);
      if (cached) clip = cached;
      else {
        const excluded = new Set<string>();
        for (const boneName of Object.values(VRMHumanBoneName)) {
          if (!LOWER_BODY_BONES.has(boneName)) continue;
          const node = this.vrm.humanoid?.getNormalizedBoneNode(boneName);
          if (node) {
            excluded.add(node.name);
            excluded.add(node.uuid);
          }
        }
        clip = new THREE.AnimationClip(
          `${loaded.name}:upper-body`,
          loaded.duration,
          loaded.tracks.filter((track) => {
            const binding = THREE.PropertyBinding.parseTrackName(track.name);
            return !excluded.has(binding.nodeName) && !excluded.has(binding.objectIndex ?? "");
          }),
          loaded.blendMode,
        );
        this.maskedClips.set(loaded, clip);
      }
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
    return { clip, profile };
  }
  private async loadClip(ref: string): Promise<THREE.AnimationClip | null> {
    const cached = this.clipCache.get(ref);
    if (cached) return cached;
    const pending = this.pendingLoads.get(ref);
    if (pending) return pending;
    const path = this.resolveRefToPath(ref);
    if (!path) return null;
    const loading = this.fetchClip(ref, path);
    this.pendingLoads.set(ref, loading);
    try {
      return await loading;
    } finally {
      this.pendingLoads.delete(ref);
    }
  }
  private async fetchClip(ref: string, path: string): Promise<THREE.AnimationClip | null> {
    try {
      const gltf = await this.loader.loadAsync(path);
      const animations = gltf.userData.vrmAnimations;
      if (!animations?.length) return null;
      const clip = createVRMAnimationClip(animations[0], this.vrm);
      // Preserve the in-place policy. Full-body foot contacts still need IK/root compensation.
      clip.tracks = clip.tracks.filter(
        (track) => !track.name.endsWith(".position") && !track.name.endsWith(".scale"),
      );
      this.prepareClip(clip, "full-body");
      this.clipCache.set(ref, clip);
      this.devLog?.write({
        phase: "load",
        note: `loaded ${ref}`,
        data: { tracks: clip.tracks.length, durationSec: clip.duration },
      });
      return clip;
    } catch (error) {
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

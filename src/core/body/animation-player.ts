/**
 * AnimationPlayer — VRMA clip loading and playback via Three.js AnimationMixer.
 *
 * Manages a single AnimationMixer bound to a VRM scene. Supports:
 * - Clip loading from .vrma files (cached by ref)
 * - Fade-in / fade-out
 * - Loop / one-shot
 * - Weight control per action
 *
 * Priority arbitration は本層では行わない。`MotionScheduler` (上位 layer) が
 * priority queue を管理し、本 player は callback 経由で driven される
 * 純粋な playback primitive。
 *
 * Three.js-dependent — not unit-testable without mocks.
 */

import type { VRM } from "@pixiv/three-vrm";
import { createVRMAnimationClip, VRMAnimationLoaderPlugin } from "@pixiv/three-vrm-animation";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { SubsystemLog } from "../dev-log";

/**
 * Alias table: persona animation ref name → actual VRMA file name (without .vrma).
 * Persona uses semantic names; this table maps them to available assets.
 */
const ANIM_ALIAS: Record<string, string> = {
  VRMA_small_nod: "Thankful",
  VRMA_head_tilt_down: "Leaning",
  VRMA_small_recoil: "Angry",
  VRMA_idle_sway: "Idle",
  VRMA_still: "VRMA_01",
  VRMA_gun_fire: "VRMA_04",
};

/** Resolved animation action with metadata. */
interface ActiveAnimation {
  readonly id: number;
  readonly ref: string;
  readonly action: THREE.AnimationAction;
  readonly startedAt: number;
  readonly loop: boolean;
  /** Fade duration applied when a non-looping action reaches its last frame. */
  readonly autoFadeOutMs: number;
  completionResolve: (() => void) | null;
  completionReject: ((err: unknown) => void) | null;
}

/**
 * Default auto-fadeOut for non-looping animations after completion.
 * Non-loop actions with `clampWhenFinished = true` otherwise hold their final
 * pose on bones that procedural-bones doesn't override (lower arms, hands,
 * fingers, upperArm .y), leaving a visible residue until the next clip fires.
 */
const DEFAULT_AUTO_FADE_OUT_MS = 400;

let nextAnimId = 1;

export class AnimationPlayer {
  private readonly mixer: THREE.AnimationMixer;
  private readonly vrm: VRM;
  private readonly loader: GLTFLoader;
  private readonly clipCache = new Map<string, THREE.AnimationClip>();
  private readonly active = new Map<number, ActiveAnimation>();
  private readonly devLog?: SubsystemLog;

  constructor(vrm: VRM, devLog?: SubsystemLog) {
    this.vrm = vrm;
    this.devLog = devLog;
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.loader = new GLTFLoader();
    this.loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

    // Listen for action completion
    this.mixer.addEventListener("finished", (e) => {
      const finishedAction = e.action as THREE.AnimationAction;
      for (const anim of this.active.values()) {
        if (anim.action === finishedAction) {
          anim.completionResolve?.();
          if (anim.loop) {
            this.active.delete(anim.id);
          } else {
            // Auto fade-out so the final-frame pose doesn't linger on bones
            // procedural-bones leaves alone (hands, fingers, upperArm.y, etc.).
            const fadeSec = anim.autoFadeOutMs / 1000;
            if (fadeSec > 0) {
              anim.action.fadeOut(fadeSec);
              setTimeout(() => {
                // Only stop if this entry is still the active one; it may have
                // been replaced or cancelled during the fade window.
                if (this.active.get(anim.id) === anim) {
                  anim.action.stop();
                  this.active.delete(anim.id);
                }
              }, anim.autoFadeOutMs);
            } else {
              anim.action.stop();
              this.active.delete(anim.id);
            }
          }
          break;
        }
      }
    });
  }

  /** Advance the mixer. Call from Body.update(). */
  update(delta: number): void {
    this.mixer.update(delta);
  }

  /**
   * Play an animation. Returns an ID and a completion promise.
   * The animation ref is resolved to a .vrma file path.
   */
  async play(
    ref: string,
    opts: {
      fadeInMs?: number;
      fadeOutMs?: number;
      weight?: number;
      loop?: boolean;
      speed?: number;
    } = {},
  ): Promise<{
    id: number;
    completion: Promise<void>;
    setWeight: (w: number, fadeMs?: number) => void;
    stop: (fadeMs?: number) => Promise<void>;
    cancel: () => void;
  }> {
    const clip = await this.loadClip(ref);
    if (!clip) {
      return {
        id: 0,
        completion: Promise.resolve(),
        setWeight: () => {},
        stop: () => Promise.resolve(),
        cancel: () => {},
      };
    }

    const action = this.mixer.clipAction(clip);
    const id = nextAnimId++;

    // reset() calls stopFading()/stopWarping() internally, which clobbers any
    // fadeIn scheduled before it. Reset first, then configure, then fade, then
    // play — this keeps the fadeIn's weight ramp intact.
    action.reset();
    action.setLoop(opts.loop ? THREE.LoopRepeat : THREE.LoopOnce, opts.loop ? Infinity : 1);
    action.clampWhenFinished = !opts.loop;
    action.setEffectiveWeight(opts.weight ?? 0.7);
    if (opts.speed !== undefined) action.setEffectiveTimeScale(opts.speed);

    // Fade in
    const fadeInSec = (opts.fadeInMs ?? 200) / 1000;
    if (fadeInSec > 0) {
      action.fadeIn(fadeInSec);
    }

    action.play();

    const { promise: completion, resolve, reject } = createDeferred();

    const anim: ActiveAnimation = {
      id,
      ref,
      action,
      startedAt: performance.now(),
      loop: opts.loop ?? false,
      autoFadeOutMs: opts.fadeOutMs ?? DEFAULT_AUTO_FADE_OUT_MS,
      completionResolve: resolve,
      completionReject: reject,
    };
    this.active.set(id, anim);

    return {
      id,
      completion,
      setWeight: (w: number, fadeMs?: number) => {
        if (!this.active.has(id)) return;
        if (fadeMs && fadeMs > 0) {
          // Three.js doesn't have setWeight with fade natively,
          // so we do an immediate set
          action.setEffectiveWeight(w);
        } else {
          action.setEffectiveWeight(w);
        }
      },
      stop: async (fadeMs?: number) => {
        if (!this.active.has(id)) return;
        const fadeSec = (fadeMs ?? 200) / 1000;
        if (fadeSec > 0) {
          action.fadeOut(fadeSec);
          // Wait for fade to complete
          await new Promise<void>((r) => setTimeout(r, fadeMs ?? 200));
        }
        action.stop();
        this.active.delete(id);
        resolve();
      },
      cancel: () => {
        if (!this.active.has(id)) return;
        action.stop();
        this.active.delete(id);
        resolve();
      },
    };
  }

  /** Stop all playing animations. */
  stopAll(fadeMs?: number): void {
    for (const anim of this.active.values()) {
      if (fadeMs && fadeMs > 0) {
        anim.action.fadeOut(fadeMs / 1000);
      } else {
        anim.action.stop();
      }
      anim.completionResolve?.();
    }
    this.active.clear();
  }

  /** Number of currently playing animations. */
  get activeCount(): number {
    return this.active.size;
  }

  /**
   * Sum of effective weights across all active actions, clamped to [0, 1].
   * Drives complementary blending with ProceduralBones: when VRMA weight rises,
   * procedural fades back so it doesn't overwrite clip-controlled bones.
   */
  getTotalEffectiveWeight(): number {
    let total = 0;
    for (const anim of this.active.values()) {
      total += anim.action.getEffectiveWeight();
      if (total >= 1) return 1;
    }
    return total;
  }

  // ── Internals ─────────────────────────────────────────

  /**
   * Resolve an animation ref to a file path and load the clip.
   * Caches by ref for reuse.
   *
   * Ref format: "anim:VRMA_small_nod" → looks for matching .vrma file
   * in the bundled animations directory.
   */
  private async loadClip(ref: string): Promise<THREE.AnimationClip | null> {
    const cached = this.clipCache.get(ref);
    if (cached) return cached;

    const path = this.resolveRefToPath(ref);
    if (!path) {
      console.warn(`[AnimationPlayer] unknown animation ref: ${ref}`);
      return null;
    }

    try {
      const gltf = await this.loader.loadAsync(path);
      const vrmAnimations = gltf.userData.vrmAnimations;
      if (!vrmAnimations || vrmAnimations.length === 0) {
        console.warn(`[AnimationPlayer] no VRM animations in: ${path}`);
        return null;
      }
      const clip = createVRMAnimationClip(vrmAnimations[0], this.vrm);
      this.devLog?.write({
        phase: "load",
        note: `loaded ${ref}`,
        data: {
          tracks: clip.tracks.length,
          durationSec: clip.duration,
          trackNames: clip.tracks.map((t) => t.name),
        },
      });
      stripRootMotion(clip);
      this.clipCache.set(ref, clip);
      return clip;
    } catch (err) {
      console.warn(`[AnimationPlayer] failed to load ${path}:`, err);
      return null;
    }
  }

  /**
   * Map animation ref string to asset path.
   * Refs are resolved via an alias table first, then by direct name.
   * Files are served from /animations/ (public/ directory).
   */
  private resolveRefToPath(ref: string): string | null {
    if (ref.startsWith("anim:")) {
      const name = ref.slice(5); // strip "anim:" prefix
      const mapped = ANIM_ALIAS[name] ?? name;
      return `/animations/${mapped}.vrma`;
    }
    if (ref.endsWith(".vrma")) {
      return ref;
    }
    return null;
  }
}

/**
 * Remove position and scale tracks from the clip to prevent VRMA animations
 * from moving/scaling the character off-screen.
 * Keeps only rotation (.quaternion) and morph target tracks.
 */
function stripRootMotion(clip: THREE.AnimationClip): void {
  clip.tracks = clip.tracks.filter(
    (track) => !track.name.endsWith(".position") && !track.name.endsWith(".scale"),
  );
}

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

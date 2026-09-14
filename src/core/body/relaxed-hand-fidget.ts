import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import * as THREE from "three";
import { createVrmRestPose } from "./vrm-rest-pose";

// A loose curl added to an already relaxed recorded hand, never a closed fist.
// Thumb, palm, wrist and arm tracks retain their authored motion.
const FINGERS = [
  ["Index", 0.11, 0.18, 0.09],
  ["Middle", 0.14, 0.21, 0.1],
  ["Ring", 0.17, 0.24, 0.12],
  ["Little", 0.19, 0.25, 0.13],
] as const;
const JOINTS = ["Proximal", "Intermediate", "Distal"] as const;

interface FingerBinding {
  readonly node: THREE.Object3D;
  readonly curl: number;
  readonly base: THREE.Quaternion;
  readonly applied: THREE.Quaternion;
  written: boolean;
}

/** Small idle-only hand-shape variation on top of the current recorded fingers.
 * The caller must restrict enabled to the exact reviewed model and hands-at-rest
 * unit, quiet idle, and no semantic/manual/claimed animation ownership.
 * Restore before the mixer; update after the mixer and before humanoid.update().
 */
export class RelaxedHandFidget {
  private readonly hands: readonly FingerBinding[][];
  private readonly rotation = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3(0, 0, 1);
  private readonly random: () => number;
  private nextSide: number;
  private activeSide = -1;
  private quietElapsed = 0;
  private waitSeconds: number;
  private episodeElapsed = 0;
  private durationSeconds = 0;
  private amount = 0;
  private velocity = 0;
  private acceleration = 0;
  private releaseElapsed = -1;
  private releaseAmount = 0;
  private releaseVelocity = 0;
  private releaseAcceleration = 0;
  private enabled = false;
  private disposed = false;

  constructor(vrm: VRM, options: { random?: () => number } = {}) {
    this.random = options.random ?? Math.random;
    const rest = createVrmRestPose(vrm);
    this.hands = (["left", "right"] as const).map((side) => {
      const sign = Math.sign(rest[side === "left" ? "leftArm" : "rightArm"].handZ);
      const bindings: FingerBinding[] = [];
      for (const [finger, ...amounts] of FINGERS) {
        for (let joint = 0; joint < JOINTS.length; joint++) {
          const node = vrm.humanoid?.getNormalizedBoneNode(
            `${side}${finger}${JOINTS[joint]}` as VRMHumanBoneName,
          );
          if (!node) return [];
          bindings.push({
            node,
            curl: sign * amounts[joint],
            base: new THREE.Quaternion(),
            applied: new THREE.Quaternion(),
            written: false,
          });
        }
      }
      return bindings;
    });
    this.nextSide = this.draw() < 0.5 ? 0 : 1;
    this.waitSeconds = this.nextWait();
  }

  restoreBaseRotations(): void {
    for (const hand of this.hands) {
      for (const binding of hand) {
        if (!binding.written) continue;
        // A direct pose owner may have written since our last update. Restore
        // only our own result; never overwrite that newer external pose.
        if (Math.abs(binding.node.quaternion.dot(binding.applied)) > 1 - 1e-12)
          binding.node.quaternion.copy(binding.base);
        binding.written = false;
      }
    }
  }

  /** allowRelease permits at most 180 ms of departing hand shape during an
   * automatic transition. Manual/claimed owners must leave it false.
   */
  update(deltaSeconds: number, enabled: boolean, allowRelease = false): void {
    this.restoreBaseRotations();
    if (this.disposed) return;
    if (
      (!enabled && !allowRelease) ||
      !Number.isFinite(deltaSeconds) ||
      deltaSeconds < 0 ||
      deltaSeconds > 0.25
    ) {
      this.cancelEpisode();
      return;
    }
    if (this.releaseElapsed >= 0) {
      this.updateRelease(deltaSeconds);
      return;
    }
    if (!enabled) {
      if (this.enabled && this.activeSide >= 0 && this.amount > 0) {
        this.releaseElapsed = 0;
        this.releaseAmount = this.amount;
        this.releaseVelocity = this.velocity;
        this.releaseAcceleration = this.acceleration;
        this.enabled = false;
        this.updateRelease(deltaSeconds);
      } else this.cancelEpisode();
      return;
    }
    this.enabled = true;
    if (this.activeSide < 0) {
      this.quietElapsed += deltaSeconds;
      if (this.quietElapsed < this.waitSeconds) return;
      if (this.hands[0].length === 0 || this.hands[1].length === 0) return;
      this.activeSide = this.nextSide;
      this.nextSide = 1 - this.nextSide;
      this.episodeElapsed = 0;
      this.durationSeconds = 2 + this.draw();
    } else {
      this.episodeElapsed += deltaSeconds;
    }
    if (this.episodeElapsed >= this.durationSeconds) {
      this.activeSide = -1;
      this.quietElapsed = 0;
      this.waitSeconds = this.nextWait();
      return;
    }
    const phase = this.episodeElapsed / this.durationSeconds;
    const x = phase < 0.45 ? phase / 0.45 : phase > 0.55 ? (1 - phase) / 0.45 : 1;
    const scale =
      phase < 0.45
        ? 1 / (0.45 * this.durationSeconds)
        : phase > 0.55
          ? -1 / (0.45 * this.durationSeconds)
          : 0;
    this.amount = smooth(x);
    this.velocity = 30 * x * x * (x - 1) * (x - 1) * scale;
    this.acceleration = 60 * x * (2 * x * x - 3 * x + 1) * scale * scale;
    this.applyAmount(this.amount);
  }

  private applyAmount(amount: number): void {
    if (amount === 0) return;
    for (const binding of this.hands[this.activeSide]) {
      binding.base.copy(binding.node.quaternion);
      this.rotation.setFromAxisAngle(this.axis, binding.curl * amount);
      binding.node.quaternion.multiply(this.rotation).normalize();
      binding.applied.copy(binding.node.quaternion);
      binding.written = true;
    }
  }

  dispose(): void {
    this.restoreBaseRotations();
    this.disposed = true;
    this.activeSide = -1;
  }

  private cancelEpisode(): void {
    if (this.enabled || this.activeSide >= 0) this.waitSeconds = this.nextWait();
    this.enabled = false;
    this.activeSide = -1;
    this.releaseElapsed = -1;
    this.quietElapsed = 0;
    this.amount = 0;
  }

  private updateRelease(deltaSeconds: number): void {
    this.releaseElapsed += deltaSeconds;
    const duration = 0.18;
    if (this.releaseElapsed >= duration - 1e-9) {
      this.cancelEpisode();
      return;
    }
    const t = this.releaseElapsed / duration;
    const t2 = t * t,
      t3 = t2 * t,
      t4 = t3 * t,
      t5 = t4 * t;
    // Quintic Hermite decay preserves the departing amount, velocity and
    // acceleration, then reaches zero with zero first/second derivatives.
    this.amount =
      this.releaseAmount * (1 - 10 * t3 + 15 * t4 - 6 * t5) +
      this.releaseVelocity * duration * (t - 6 * t3 + 8 * t4 - 3 * t5) +
      0.5 * this.releaseAcceleration * duration * duration * (t2 - 3 * t3 + 3 * t4 - t5);
    this.applyAmount(this.amount);
  }

  private draw(): number {
    const value = this.random();
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
  }

  private nextWait(): number {
    return 18 + 18 * this.draw();
  }
}

function smooth(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

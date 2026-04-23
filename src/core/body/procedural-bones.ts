/**
 * ProceduralBones — spine sway, head drift, arm micro-sway.
 *
 * Ported from old Charminal's ProceduralSource.ts.
 * These bone-level procedural animations add "life" to the idle/thinking pose
 * on top of the static rest pose set by setupRestPose.
 *
 * VRM-dependent: needs normalized bone references from VRM.humanoid.
 */

import type { VRM } from "@pixiv/three-vrm";
import type * as THREE from "three";

// ─── Constants ───────────────────────────────────────────

// Head drift
const HEAD_DRIFT_AMP_Z = 0.04; // lateral tilt (radians)
const HEAD_DRIFT_AMP_Y = 0.05; // yaw rotation (radians)
const HEAD_DRIFT_SPEED = 1.2; // lerp speed (units/sec)
const HEAD_LOOK_AT_SPEED = 2.2;

// Rest pose base values for arms (must match setupRestPose in vrm-viewer.tsx)
const LEFT_ARM_BASE_Z = 1.35;
const LEFT_ARM_BASE_X = 0.1;
const RIGHT_ARM_BASE_Z = -1.35;
const RIGHT_ARM_BASE_X = 0.1;

// ─── Utility ─────────────────────────────────────────────

function lerpDelta(current: number, target: number, speed: number, delta: number): number {
  return current + (target - current) * Math.min(speed * delta, 1.0);
}

// ─── ProceduralBones ─────────────────────────────────────

export class ProceduralBones {
  private spineBone: THREE.Object3D | null = null;
  private headBone: THREE.Object3D | null = null;
  private leftUpperArm: THREE.Object3D | null = null;
  private rightUpperArm: THREE.Object3D | null = null;

  // Head drift state
  private headDriftTargetZ = 0;
  private headDriftTargetY = 0;
  private headDriftCurrentZ = 0;
  private headDriftCurrentY = 0;
  private headDriftTimer = 1.5 + Math.random() * 2.0;
  private headLookAtTargetX = 0;
  private headLookAtTargetY = 0;
  private headLookAtCurrentX = 0;
  private headLookAtCurrentY = 0;
  private headLookAtAppliedX = 0;
  private headLookAtAppliedY = 0;

  /** When true, head drift amplitude increases ×2.8 and interval shortens. */
  isThinking = false;

  private readonly random: () => number;

  constructor(random?: () => number) {
    this.random = random ?? Math.random;
  }

  /** Bind to VRM normalized bones. Call after VRM loads + rest pose setup. */
  bindVrm(vrm: VRM): void {
    const h = vrm.humanoid;
    this.spineBone = h.getNormalizedBoneNode("spine") ?? h.getNormalizedBoneNode("chest");
    this.headBone = h.getNormalizedBoneNode("head");
    this.leftUpperArm = h.getNormalizedBoneNode("leftUpperArm");
    this.rightUpperArm = h.getNormalizedBoneNode("rightUpperArm");
  }

  setHeadLookAtOffset(yawRad: number, pitchRad: number): void {
    this.headLookAtTargetY = yawRad;
    this.headLookAtTargetX = pitchRad;
  }

  /**
   * Per-frame update. Applies bone rotations directly.
   * `weight` is used to blend with VRMA animations (1.0 = full procedural).
   */
  update(delta: number, elapsed: number, weight = 1.0): void {
    const w = weight;

    // ── Spine sway ──────────────────────────────────────
    if (this.spineBone && w >= 0.001) {
      this.spineBone.rotation.z = Math.sin(elapsed * 0.6) * 0.015 * w;
      this.spineBone.rotation.x = Math.sin(elapsed * 0.4) * 0.008 * w;
    }

    // ── Head drift ──────────────────────────────────────
    if (this.headBone) {
      this.headDriftTimer -= delta;
      if (this.headDriftTimer <= 0) {
        const ampZ = this.isThinking ? HEAD_DRIFT_AMP_Z * 2.8 : HEAD_DRIFT_AMP_Z;
        const ampY = this.isThinking ? HEAD_DRIFT_AMP_Y * 2.8 : HEAD_DRIFT_AMP_Y;
        this.headDriftTargetZ = (this.random() - 0.5) * 2 * ampZ;
        this.headDriftTargetY = (this.random() - 0.5) * 2 * ampY;
        this.headDriftTimer = this.isThinking
          ? 1.0 + this.random() * 2.0
          : 2.0 + this.random() * 3.0;
      }
      this.headDriftCurrentZ = lerpDelta(
        this.headDriftCurrentZ,
        this.headDriftTargetZ,
        HEAD_DRIFT_SPEED,
        delta,
      );
      this.headDriftCurrentY = lerpDelta(
        this.headDriftCurrentY,
        this.headDriftTargetY,
        HEAD_DRIFT_SPEED,
        delta,
      );
      this.headLookAtCurrentX = lerpDelta(
        this.headLookAtCurrentX,
        this.headLookAtTargetX,
        HEAD_LOOK_AT_SPEED,
        delta,
      );
      this.headLookAtCurrentY = lerpDelta(
        this.headLookAtCurrentY,
        this.headLookAtTargetY,
        HEAD_LOOK_AT_SPEED,
        delta,
      );
      this.headBone.rotation.x -= this.headLookAtAppliedX;
      this.headBone.rotation.y -= this.headLookAtAppliedY;
      if (w >= 0.001) {
        this.headBone.rotation.z = this.headDriftCurrentZ * w;
        this.headBone.rotation.y = this.headDriftCurrentY * w;
      }
      this.headBone.rotation.x += this.headLookAtCurrentX;
      this.headBone.rotation.y += this.headLookAtCurrentY;
      this.headLookAtAppliedX = this.headLookAtCurrentX;
      this.headLookAtAppliedY = this.headLookAtCurrentY;
    }

    // ── Arm micro-sway ──────────────────────────────────
    // Rest pose base + small sine offset (phase-shifted per arm)
    if (this.leftUpperArm && w >= 0.001) {
      this.leftUpperArm.rotation.z = LEFT_ARM_BASE_Z + Math.sin(elapsed * 0.5 + 1.2) * 0.02 * w;
      this.leftUpperArm.rotation.x = LEFT_ARM_BASE_X + Math.sin(elapsed * 0.35) * 0.015 * w;
    }
    if (this.rightUpperArm && w >= 0.001) {
      this.rightUpperArm.rotation.z = RIGHT_ARM_BASE_Z + Math.sin(elapsed * 0.5 + 2.4) * 0.02 * w;
      this.rightUpperArm.rotation.x = RIGHT_ARM_BASE_X + Math.sin(elapsed * 0.35 + 1.8) * 0.015 * w;
    }
  }
}

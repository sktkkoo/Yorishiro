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
import { OrganicNoise } from "./organic-noise";
import { createVrmRestPose, type VrmRestPose } from "./vrm-rest-pose";

// ─── Constants ───────────────────────────────────────────

// Head drift
const HEAD_DRIFT_AMP_Z = 0.04; // lateral tilt (radians)
const HEAD_DRIFT_AMP_Y = 0.05; // yaw rotation (radians)
const HEAD_DRIFT_SPEED = 1.2; // lerp speed (units/sec)
const HEAD_LOOK_AT_SPEED = 1.2;

// Posture shift — 立ち姿の重心がゆっくり入れ替わる（数十秒スケール）。
// sway（数秒スケール）より一段遅い層で「ずっと同じ姿勢で固まっていない」
// 実在感を作る。
const POSTURE_LEAN_AMP = 0.012; // radians
const POSTURE_MIN_S = 20;
const POSTURE_MAX_S = 50;
const POSTURE_LERP_SPEED = 0.3; // units/sec（とてもゆっくり）

// Startle flinch — 予期しない失敗イベントへの頭の微小な引き（chin tuck）。
// 演出ではなく生理反射なので振幅は小さく、一拍で戻る。
const FLINCH_DURATION_S = 0.45;
const FLINCH_PITCH_RAD = -0.045; // 負 = chin down
// idle/thinking 中の頭 pitch の「中心」を少し下げる静的バイアス（radians, 負で chin down）。
// drift（z/y）と違い pitch には揺らぎが無く中心が素のポーズ任せだったため、ここで中心だけ寄せる。
// procedural weight に乗せるので、conscious animation 中はフェードして効かない。
const HEAD_REST_PITCH_RAD = -0.035;

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
  private restPose: VrmRestPose | null = null;

  // BreathingSystem からの胸郭・肩オフセット（毎フレーム Body が供給）。
  // spine sway / arm sway と同じ bone に加算合成するためここで適用する。
  private breathChestPitch = 0;
  private breathShoulderLift = 0;

  /** When true, head drift amplitude increases ×1.8 and interval shortens. */
  private _isThinking = false;

  get isThinking(): boolean {
    return this._isThinking;
  }

  set isThinking(value: boolean) {
    if (this._isThinking === value) return;
    this._isThinking = value;
    if (!value) {
      // thinking → idle: drift target を即リセットして頭が素早く正面に戻るようにする。
      // 旧実装では amplified drift position からの復帰が遅い lerp で 3-6 秒かかっていた。
      this.headDriftTargetZ = 0;
      this.headDriftTargetY = 0;
      this.headDriftTimer = 0.5 + Math.random() * 1.0;
    }
  }

  // Posture shift state
  private postureLeanZ = 0;
  private postureLeanTarget = 0;
  private postureTimer: number;

  // Startle flinch state（残り時間。0 で非アクティブ）
  private flinchTimer = 0;

  private readonly random: () => number;

  // Sway noise（旧実装の単一 sine を置換。周波数帯は同等、波形だけ有機化）。
  // 各 instance が独立位相を持つので左右非対称・非同期になる。
  private readonly swaySpineZ: OrganicNoise;
  private readonly swaySpineX: OrganicNoise;
  private readonly swayArmLeftZ: OrganicNoise;
  private readonly swayArmLeftX: OrganicNoise;
  private readonly swayArmRightZ: OrganicNoise;
  private readonly swayArmRightX: OrganicNoise;

  constructor(random?: () => number) {
    this.random = random ?? Math.random;
    this.swaySpineZ = new OrganicNoise(0.6, this.random);
    this.swaySpineX = new OrganicNoise(0.4, this.random);
    this.swayArmLeftZ = new OrganicNoise(0.5, this.random);
    this.swayArmLeftX = new OrganicNoise(0.35, this.random);
    this.swayArmRightZ = new OrganicNoise(0.5, this.random);
    this.swayArmRightX = new OrganicNoise(0.35, this.random);
    // 最初の重心移動は早めに入れる（起動直後の「固まり」を避ける）
    this.postureTimer = 5 + this.random() * 15;
  }

  /** Bind to VRM normalized bones. Call after VRM loads + rest pose setup. */
  bindVrm(vrm: VRM): void {
    const h = vrm.humanoid;
    this.spineBone = h.getNormalizedBoneNode("spine") ?? h.getNormalizedBoneNode("chest");
    this.headBone = h.getNormalizedBoneNode("head");
    this.leftUpperArm = h.getNormalizedBoneNode("leftUpperArm");
    this.rightUpperArm = h.getNormalizedBoneNode("rightUpperArm");
    this.restPose = createVrmRestPose(vrm);
  }

  setHeadLookAtOffset(yawRad: number, pitchRad: number): void {
    this.headLookAtTargetY = yawRad;
    this.headLookAtTargetX = pitchRad;
  }

  /** BreathingSystem の胸郭・肩オフセットを受け取る。update で weight 込みで適用。 */
  setBreathingOffsets(chestPitchRad: number, shoulderLiftRad: number): void {
    this.breathChestPitch = chestPitchRad;
    this.breathShoulderLift = shoulderLiftRad;
  }

  /**
   * Eye-head coordination：大きい saccade の後、頭が視線方向へ遅れて追従する。
   * drift target を視線方向に向けるだけなので、動き自体は通常の drift lerp
   * （HEAD_DRIFT_SPEED）が作る = 目が先、頭が後の生理的な順序になる。
   */
  nudgeHeadToward(yawRad: number): void {
    const limit = HEAD_DRIFT_AMP_Y * 2;
    this.headDriftTargetY = Math.max(-limit, Math.min(limit, yawRad));
    // しばらくこの向きを保持してから通常 drift に戻る
    this.headDriftTimer = 1.0 + this.random() * 1.5;
  }

  /** Startle 反射：頭が一瞬小さく引いて（chin tuck）一拍で戻る。 */
  flinchHead(): void {
    this.flinchTimer = FLINCH_DURATION_S;
  }

  /** Drop one-shot reflex overlays that should not replay after animation claim release. */
  clearTransientReflexes(): void {
    this.flinchTimer = 0;
  }

  /**
   * Per-frame update. Applies bone rotations directly.
   * `weight` is used to blend with VRMA animations (1.0 = full procedural).
   */
  update(delta: number, elapsed: number, weight = 1.0): void {
    const w = weight;

    // ── Posture shift（重心の入れ替わり）─────────────────
    this.postureTimer -= delta;
    if (this.postureTimer <= 0) {
      this.postureLeanTarget = (this.random() - 0.5) * 2 * POSTURE_LEAN_AMP;
      this.postureTimer = POSTURE_MIN_S + this.random() * (POSTURE_MAX_S - POSTURE_MIN_S);
    }
    this.postureLeanZ = lerpDelta(
      this.postureLeanZ,
      this.postureLeanTarget,
      POSTURE_LERP_SPEED,
      delta,
    );

    // ── Spine sway ──────────────────────────────────────
    if (this.spineBone && w >= 0.001) {
      this.spineBone.rotation.z = (this.swaySpineZ.sample(elapsed) * 0.015 + this.postureLeanZ) * w;
      this.spineBone.rotation.x =
        (this.swaySpineX.sample(elapsed) * 0.008 + this.breathChestPitch) * w;
    }

    // ── Head drift ──────────────────────────────────────
    if (this.headBone) {
      this.headDriftTimer -= delta;
      if (this.headDriftTimer <= 0) {
        const ampZ = this.isThinking ? HEAD_DRIFT_AMP_Z * 1.8 : HEAD_DRIFT_AMP_Z;
        const ampY = this.isThinking ? HEAD_DRIFT_AMP_Y * 1.8 : HEAD_DRIFT_AMP_Y;
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
      // pitch の中心を procedural weight ぶんだけ下げる（揺らぎ自体は据え置き）。
      // look-at と同じ applied/current 方式に畳んで冪等に保つ。
      const restPitchX = HEAD_REST_PITCH_RAD * w;
      // Startle flinch：単発の sin envelope で沈んで戻る
      let flinchX = 0;
      if (this.flinchTimer > 0) {
        this.flinchTimer = Math.max(0, this.flinchTimer - delta);
        const p = 1 - this.flinchTimer / FLINCH_DURATION_S;
        flinchX = Math.sin(Math.PI * p) * FLINCH_PITCH_RAD * w;
      }
      const appliedPitchX = this.headLookAtCurrentX + restPitchX + flinchX;
      this.headBone.rotation.x -= this.headLookAtAppliedX;
      this.headBone.rotation.y -= this.headLookAtAppliedY;
      if (w >= 0.001) {
        this.headBone.rotation.z = this.headDriftCurrentZ * w;
        this.headBone.rotation.y = this.headDriftCurrentY * w;
      }
      this.headBone.rotation.x += appliedPitchX;
      this.headBone.rotation.y += this.headLookAtCurrentY;
      this.headLookAtAppliedX = appliedPitchX;
      this.headLookAtAppliedY = this.headLookAtCurrentY;
    }

    // ── Arm micro-sway ──────────────────────────────────
    // Rest pose base + small sine offset (phase-shifted per arm)
    const restPose = this.restPose;
    // 呼吸の肩上げは左右ミラー（吸気で両肩がわずかに開く / 上がる）。
    // sway は腕ごとに独立 noise（左右非対称・非同期）。
    if (this.leftUpperArm && restPose && w >= 0.001) {
      this.leftUpperArm.rotation.z =
        restPose.leftArm.upperArmZ +
        (this.swayArmLeftZ.sample(elapsed) * 0.02 + this.breathShoulderLift) * w;
      this.leftUpperArm.rotation.x =
        restPose.leftArm.upperArmX + this.swayArmLeftX.sample(elapsed) * 0.015 * w;
    }
    if (this.rightUpperArm && restPose && w >= 0.001) {
      this.rightUpperArm.rotation.z =
        restPose.rightArm.upperArmZ +
        (this.swayArmRightZ.sample(elapsed) * 0.02 - this.breathShoulderLift) * w;
      this.rightUpperArm.rotation.x =
        restPose.rightArm.upperArmX + this.swayArmRightX.sample(elapsed) * 0.015 * w;
    }
  }
}

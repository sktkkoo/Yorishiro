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
import type { EyeState } from "./eye-system";
import { motionGain, springParams } from "./motion-gain";
import { OrganicNoise } from "./organic-noise";
import { Spring1D } from "./spring";
import { StatePoseBlender } from "./state-pose";
import { createVrmRestPose, type VrmRestPose } from "./vrm-rest-pose";

// ─── Constants ───────────────────────────────────────────

// Head drift
const HEAD_DRIFT_AMP_Z = 0.04; // lateral tilt (radians)
const HEAD_DRIFT_AMP_Y = 0.05; // yaw rotation (radians)
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
  private headDriftTimer = 1.5 + Math.random() * 2.0;
  private readonly headSpringZ: Spring1D;
  private readonly headSpringY: Spring1D;
  private readonly armSpringLeftZ: Spring1D;
  private readonly armSpringLeftX: Spring1D;
  private readonly armSpringRightZ: Spring1D;
  private readonly armSpringRightX: Spring1D;
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

  private activityState: EyeState = "idle";

  // Posture shift state
  private postureLeanZ = 0;
  private postureLeanTarget = 0;
  private postureTimer: number;

  // Startle flinch state（残り時間。0 で非アクティブ）
  private flinchTimer = 0;
  private spineEnvelopeZ = 0;
  private spineEnvelopeX = 0;
  private spineEnvelopeTimer = 0;
  private postureEnvelope = 0;
  private postureEnvelopeTimer = 0;
  private intensity = 1.0;
  private readonly statePose = new StatePoseBlender();

  private readonly random: () => number;

  // Sway noise（旧実装の単一 sine を置換。周波数帯は同等、波形だけ有機化）。
  // 各 instance が独立位相を持つので左右非対称・非同期になる。
  private readonly swaySpineZ: OrganicNoise;
  private readonly swaySpineX: OrganicNoise;
  private readonly swaySpringZ: Spring1D;
  private readonly swaySpringX: Spring1D;

  constructor(random?: () => number) {
    this.random = random ?? Math.random;
    this.swaySpineZ = new OrganicNoise(0.6, this.random);
    this.swaySpineX = new OrganicNoise(0.4, this.random);
    // 最初の重心移動は早めに入れる（起動直後の「固まり」を避ける）
    this.postureTimer = 5 + this.random() * 15;
    const sp = springParams(1.0);
    this.swaySpringZ = new Spring1D({ omega: sp.spineOmega, zeta: sp.spineZeta });
    this.swaySpringX = new Spring1D({ omega: sp.spineOmega, zeta: sp.spineZeta });
    this.headSpringZ = new Spring1D({ omega: sp.headOmega, zeta: sp.headZeta });
    this.headSpringY = new Spring1D({ omega: sp.headOmega, zeta: sp.headZeta });
    this.armSpringLeftZ = new Spring1D({ omega: sp.armOmega, zeta: sp.armZeta });
    this.armSpringLeftX = new Spring1D({ omega: sp.armOmega, zeta: sp.armZeta });
    this.armSpringRightZ = new Spring1D({ omega: sp.armOmega, zeta: sp.armZeta });
    this.armSpringRightX = new Spring1D({ omega: sp.armOmega, zeta: sp.armZeta });
  }

  /** idle motion 倍率（0-3, 1 で現状）。spring パラメータ + 振幅 gain を更新。 */
  setIntensity(intensity: number): void {
    this.intensity = intensity;
    const sp = springParams(intensity);
    this.swaySpringZ.setParams(sp.spineOmega, sp.spineZeta);
    this.swaySpringX.setParams(sp.spineOmega, sp.spineZeta);
    this.headSpringZ.setParams(sp.headOmega, sp.headZeta);
    this.headSpringY.setParams(sp.headOmega, sp.headZeta);
    this.armSpringLeftZ.setParams(sp.armOmega, sp.armZeta);
    this.armSpringLeftX.setParams(sp.armOmega, sp.armZeta);
    this.armSpringRightZ.setParams(sp.armOmega, sp.armZeta);
    this.armSpringRightX.setParams(sp.armOmega, sp.armZeta);
  }

  /** state をそのまま受け取り、activity に応じた head drift 調整を行う。 */
  setActivityState(state: EyeState): void {
    const wasActive = this.isActiveState(this.activityState);
    this.activityState = state;
    this.statePose.setState(state);
    if (!this.isActiveState(state) && wasActive) {
      // active state → idle/writing: drift target を即リセットして頭が素早く正面に戻るようにする。
      this.headDriftTargetZ = 0;
      this.headDriftTargetY = 0;
      this.headDriftTimer = 0.5 + this.random() * 1.0;
    }
  }

  private isActiveState(state: EyeState): boolean {
    return state === "thinking" || state === "reading" || state === "running";
  }

  /** spine spring target に transient offset を追加。durationS 後に 0 に戻る。 */
  addSpineEnvelope(z: number, x: number, durationS: number): void {
    this.spineEnvelopeZ = z;
    this.spineEnvelopeX = x;
    this.spineEnvelopeTimer = durationS;
  }

  /** posture バイアスを一時変更。durationS 後に 0 に戻る。 */
  addPostureEnvelope(leanZ: number, durationS: number): void {
    this.postureEnvelope = leanZ;
    this.postureEnvelopeTimer = durationS;
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
   * drift target を視線方向に向けるだけなので、動き自体は通常の head spring が作る
   * = 目が先、頭が後の生理的な順序になる。
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
    this.statePose.update(delta);
    const swayGain = motionGain(this.intensity, "sway");
    const headGain = motionGain(this.intensity, "head");
    const postureGain = motionGain(this.intensity, "posture");

    // ── Posture shift（重心の入れ替わり）─────────────────
    this.postureTimer -= delta;
    if (this.postureTimer <= 0) {
      this.postureLeanTarget = (this.random() - 0.5) * 2 * POSTURE_LEAN_AMP * postureGain;
      this.postureTimer = POSTURE_MIN_S + this.random() * (POSTURE_MAX_S - POSTURE_MIN_S);
    }
    const postureLerpSpeed =
      this.postureEnvelopeTimer > 0 ? Math.max(POSTURE_LERP_SPEED, 1.8) : POSTURE_LERP_SPEED;
    this.postureLeanZ = lerpDelta(
      this.postureLeanZ,
      this.postureLeanTarget + this.postureEnvelope,
      postureLerpSpeed,
      delta,
    );

    // ── Spine sway（continuous noise → spring パススルー）──
    const swayRawZ = this.swaySpineZ.sample(elapsed) * 0.015 * swayGain * this.statePose.swayScale;
    const swayRawX = this.swaySpineX.sample(elapsed) * 0.008 * swayGain * this.statePose.swayScale;
    this.swaySpringZ.update(delta, swayRawZ + this.spineEnvelopeZ);
    this.swaySpringX.update(delta, swayRawX + this.spineEnvelopeX);

    if (this.spineEnvelopeTimer > 0) {
      this.spineEnvelopeTimer -= delta;
      if (this.spineEnvelopeTimer <= 0) {
        this.spineEnvelopeZ = 0;
        this.spineEnvelopeX = 0;
      }
    }
    if (this.postureEnvelopeTimer > 0) {
      this.postureEnvelopeTimer -= delta;
      if (this.postureEnvelopeTimer <= 0) {
        this.postureEnvelope = 0;
      }
    }

    if (this.spineBone && w >= 0.001) {
      this.spineBone.rotation.z = (this.swaySpringZ.pos + this.postureLeanZ) * w;
      this.spineBone.rotation.x =
        (this.swaySpringX.pos + this.breathChestPitch + this.statePose.spinePitch) * w;
    }

    // ── Head drift ──────────────────────────────────────
    if (this.headBone) {
      this.headDriftTimer -= delta;
      if (this.headDriftTimer <= 0) {
        const ampZ = HEAD_DRIFT_AMP_Z * headGain * this.statePose.driftAmpScale;
        const ampY = HEAD_DRIFT_AMP_Y * headGain * this.statePose.driftAmpScale;
        this.headDriftTargetZ = (this.random() - 0.5) * 2 * ampZ;
        this.headDriftTargetY = (this.random() - 0.5) * 2 * ampY;
        const sp = springParams(this.intensity);
        const baseTimer = 2.0 + this.random() * 3.0;
        this.headDriftTimer = baseTimer * sp.headTimerScale * this.statePose.driftIntervalScale;
      }
      this.headSpringZ.update(delta, this.headDriftTargetZ);
      this.headSpringY.update(delta, this.headDriftTargetY);
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
      const headArc = Math.abs(this.headSpringZ.pos) * 0.3 * w;
      const appliedPitchX =
        this.headLookAtCurrentX + restPitchX + flinchX - headArc + this.statePose.headPitch * w;
      this.headBone.rotation.x -= this.headLookAtAppliedX;
      this.headBone.rotation.y -= this.headLookAtAppliedY;
      if (w >= 0.001) {
        this.headBone.rotation.z = this.headSpringZ.pos * w;
        this.headBone.rotation.y = this.headSpringY.pos * w;
      }
      this.headBone.rotation.x += appliedPitchX;
      this.headBone.rotation.y += this.headLookAtCurrentY;
      this.headLookAtAppliedX = appliedPitchX;
      this.headLookAtAppliedY = this.headLookAtCurrentY;
    }

    // ── Arm drag（spine → 遅延追従）──────────────────────
    const restPose = this.restPose;
    // swaySpringZ/X.pos は既に swayGain 込みの target を追従しているので再乗算しない。
    const spineZ = this.swaySpringZ.pos;
    const spineX = this.swaySpringX.pos;
    this.armSpringLeftZ.update(delta, spineZ * 1.3);
    this.armSpringLeftX.update(delta, spineX * 1.0);
    this.armSpringRightZ.update(delta, spineZ * 1.25);
    this.armSpringRightX.update(delta, spineX * 0.95);

    // 呼吸の肩上げは左右ミラー（吸気で両肩がわずかに開く / 上がる）。
    if (this.leftUpperArm && restPose && w >= 0.001) {
      this.leftUpperArm.rotation.z =
        restPose.leftArm.upperArmZ + (this.armSpringLeftZ.pos + this.breathShoulderLift) * w;
      this.leftUpperArm.rotation.x = restPose.leftArm.upperArmX + this.armSpringLeftX.pos * w;
    }
    if (this.rightUpperArm && restPose && w >= 0.001) {
      this.rightUpperArm.rotation.z =
        restPose.rightArm.upperArmZ + (this.armSpringRightZ.pos - this.breathShoulderLift) * w;
      this.rightUpperArm.rotation.x = restPose.rightArm.upperArmX + this.armSpringRightX.pos * w;
    }
  }
}

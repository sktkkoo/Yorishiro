/**
 * IdleBeatScheduler — state-aware な pose beat 発火システム。
 * Body 内の生理層(breathing/blink と同列)。
 * Internal design-record: 2026-06-17-motion-aliveness-research.md / p3-design §14
 * Pure data logic, no VRM dependency.
 */

import type {
  BeatDef,
  BeatKeyframe,
  BeatProfile,
  BeatProfileMap,
  BeatSecondaryAction,
  BeatTarget,
} from "./beat-types";
import type { EyeState } from "./eye-system";
import { beatAccentRate, sampleSkewedInterval } from "./motion-gain";

const GLOBAL_COOLDOWN_S = 0.5;
const HEAVY_BUDGET_INTERVAL_S = 30;
const QUIET_WINDOW_AFTER_HEAVY_S = 3;

interface PendingAction {
  remainingDelay: number;
  keyframe?: BeatKeyframe;
  secondary?: BeatSecondaryAction;
}

export class IdleBeatScheduler {
  private state: EyeState = "idle";
  private prevState: EyeState = "idle";
  private intensity = 1.0;
  private beatTimer: number;
  private globalCooldown = 0;
  private heavyBudgetTimer = 0;
  private lastGlanceYawSign = 0;
  private readonly beatCooldowns = new Map<string, number>();
  private pendingActions: PendingAction[] = [];
  private readonly pendingActionPool: PendingAction[] = [];
  private sequenceActive = false;
  private readonly profiles: BeatProfileMap;
  private readonly random: () => number;

  constructor(profiles: BeatProfileMap, random?: () => number) {
    this.profiles = profiles;
    this.random = random ?? Math.random;
    this.beatTimer = 2 + this.random() * 3;
  }

  setIntensity(intensity: number): void {
    this.intensity = intensity;
  }

  setState(state: EyeState, target: BeatTarget): void {
    const changed = state !== this.state;
    this.prevState = this.state;
    this.state = state;
    this.releasePendingActions();
    this.sequenceActive = false;
    this.beatTimer = this.nextInterval(this.profiles[this.state]);
    if (changed) this.fireTransitionBeat(target);
  }

  update(
    delta: number,
    target: BeatTarget,
    animationClaimed: boolean,
    expressionClaimed: boolean,
  ): void {
    this.globalCooldown = Math.max(0, this.globalCooldown - delta);
    this.heavyBudgetTimer = Math.max(0, this.heavyBudgetTimer - delta);
    for (const [name, remaining] of this.beatCooldowns) {
      const next = remaining - delta;
      if (next <= 0) this.beatCooldowns.delete(name);
      else this.beatCooldowns.set(name, next);
    }

    this.processPendingActions(delta, target, animationClaimed, expressionClaimed);
    if (this.sequenceActive || this.globalCooldown > 0) return;

    const profile = this.profiles[this.state];
    if (!profile || profile.beats.length === 0) return;
    this.beatTimer -= delta;
    if (this.beatTimer > 0) return;

    this.beatTimer = this.nextInterval(profile);
    const beat = this.pickBeat(profile);
    if (beat) this.fireBeat(beat);
  }

  private nextInterval(profile: BeatProfile | undefined): number {
    if (!profile) return 999;
    return Math.max(
      GLOBAL_COOLDOWN_S,
      sampleSkewedInterval(this.computeInterval(profile), this.random),
    );
  }

  private computeInterval(profile: BeatProfile): number {
    if (!profile.scaleWithIntensity) return profile.baseInterval;
    const rate = beatAccentRate(this.intensity);
    if (rate <= 0.25) return 999;
    return Math.min(profile.baseInterval, 60 / rate);
  }

  private pickBeat(profile: BeatProfile): BeatDef | null {
    let count = 0;
    for (const beat of profile.beats) {
      if (this.beatCooldowns.has(beat.name)) continue;
      if (beat.weight === "heavy" && this.heavyBudgetTimer > 0) continue;
      count += 1;
    }
    if (count === 0) return null;

    let pickIndex = Math.floor(this.random() * count);
    for (const beat of profile.beats) {
      if (this.beatCooldowns.has(beat.name)) continue;
      if (beat.weight === "heavy" && this.heavyBudgetTimer > 0) continue;
      if (pickIndex === 0) return beat;
      pickIndex -= 1;
    }
    return null;
  }

  private fireBeat(beat: BeatDef): void {
    this.beatCooldowns.set(beat.name, beat.cooldown);
    this.globalCooldown = GLOBAL_COOLDOWN_S;
    if (beat.weight === "heavy") {
      this.heavyBudgetTimer = HEAVY_BUDGET_INTERVAL_S;
      this.globalCooldown = Math.max(this.globalCooldown, QUIET_WINDOW_AFTER_HEAVY_S);
    }
    for (const keyframe of beat.keyframes) {
      this.addPendingAction(keyframe.at, keyframe, undefined);
    }
    if (beat.secondaryActions) {
      for (const secondary of beat.secondaryActions) {
        this.addPendingAction(secondary.at, undefined, secondary);
      }
    }
    this.sequenceActive = true;
  }

  private addPendingAction(
    remainingDelay: number,
    keyframe: BeatKeyframe | undefined,
    secondary: BeatSecondaryAction | undefined,
  ): void {
    const action = this.pendingActionPool.pop() ?? { remainingDelay: 0 };
    action.remainingDelay = remainingDelay;
    action.keyframe = keyframe;
    action.secondary = secondary;
    this.pendingActions.push(action);
  }

  private processPendingActions(
    delta: number,
    target: BeatTarget,
    animationClaimed: boolean,
    expressionClaimed: boolean,
  ): void {
    if (this.pendingActions.length === 0) {
      this.sequenceActive = false;
      return;
    }
    let writeIndex = 0;
    for (const action of this.pendingActions) {
      const next = action.remainingDelay - delta;
      if (next > 0) {
        action.remainingDelay = next;
        this.pendingActions[writeIndex] = action;
        writeIndex += 1;
        continue;
      }
      if (action.keyframe) this.applyKeyframe(action.keyframe, target, animationClaimed);
      if (action.secondary && !expressionClaimed) action.secondary.fire(target);
      this.releasePendingAction(action);
    }
    this.pendingActions.length = writeIndex;
    if (writeIndex === 0) this.sequenceActive = false;
  }

  private releasePendingActions(): void {
    for (const action of this.pendingActions) {
      this.releasePendingAction(action);
    }
    this.pendingActions.length = 0;
  }

  private releasePendingAction(action: PendingAction): void {
    action.remainingDelay = 0;
    action.keyframe = undefined;
    action.secondary = undefined;
    this.pendingActionPool.push(action);
  }

  private applyKeyframe(
    keyframe: BeatKeyframe,
    target: BeatTarget,
    animationClaimed: boolean,
  ): void {
    const pose = keyframe.pose;
    if (pose.gaze) {
      let yaw = pose.gaze.yaw;
      if (Math.sign(yaw) === this.lastGlanceYawSign && this.lastGlanceYawSign !== 0) yaw = -yaw;
      this.lastGlanceYawSign = Math.sign(yaw);
      target.glance(yaw, pose.gaze.pitch, pose.gaze.durationS);
    }
    if (animationClaimed) return;
    if (pose.spine)
      target.addSpineEnvelope(pose.spine.z ?? 0, pose.spine.x ?? 0, pose.spine.durationS);
    if (pose.posture) target.addPostureEnvelope(pose.posture.leanZ, pose.posture.durationS);
  }

  private fireTransitionBeat(target: BeatTarget): void {
    const to = this.state;
    if (to === "thinking") {
      // 姿勢が起きる + 斜め上へ視線を逃がし始める(cognitive aversion の口火)
      target.addSpineEnvelope(0.005, 0, 0.5);
      target.glance(0.04, -0.05, 1.0);
    } else if (to === "writing" && this.prevState === "thinking") {
      target.addSpineEnvelope(0, -0.004, 0.3);
      target.addPostureEnvelope(0.003, 2.0);
    } else if (to === "reading" && this.prevState === "thinking") {
      target.glance(0, -0.04, 0.8);
    } else if (to === "idle") {
      target.addPostureEnvelope(-0.004, 3.0);
      target.triggerDeepBreath();
    }
  }
}

import type { MotionHandle } from "@yorishiro/sdk";
import type { Body } from "../../core/body";
import type { SpeechMicroexpressionParams } from "../../core/body/speech-microexpression-system";
import type { StateExpressionSchedulerCallbacks } from "./scheduler";
import type { GroundedAgentState, StateExpressionCue, StateExpressionGestureIntent } from "./types";

type StateExpressionBody = Pick<
  Body,
  | "acquireMotionSlot"
  | "releaseSpeechMood"
  | "resetSpeechExpressionParams"
  | "setSpeechExpressionParams"
  | "setSpeechMood"
>;

interface OwnedStateExpression {
  readonly body: StateExpressionBody;
  readonly moodActive: boolean;
  motion: MotionHandle | null;
  releaseTimer: ReturnType<typeof globalThis.setTimeout> | null;
}

const GESTURE_ANIMATION: Readonly<Partial<Record<StateExpressionGestureIntent, string>>> = {
  agree: "anim:VRMA_small_nod",
  consider: "anim:VRMA_head_tilt_down",
  reassure: "anim:VRMA_small_nod",
  emphasize: "anim:VRMA_small_nod",
};

const MICROEXPRESSION_PROFILES: Readonly<
  Record<GroundedAgentState, Partial<SpeechMicroexpressionParams>>
> = {
  acknowledging: subtleProfile(0.045, 0.032, 0.035, 0.62, 1_900),
  appreciative: subtleProfile(0.055, 0.04, 0.045, 0.68, 1_800),
  concerned: subtleProfile(0.025, 0.02, 0.015, 0.42, 2_400),
  considering: subtleProfile(0.035, 0.025, 0.02, 0.48, 2_300),
  discovering: subtleProfile(0.055, 0.04, 0.045, 0.62, 2_000),
  emphatic: subtleProfile(0.06, 0.04, 0.05, 0.58, 1_900),
  progressing: subtleProfile(0.045, 0.03, 0.03, 0.58, 2_100),
  reassuring: subtleProfile(0.04, 0.03, 0.025, 0.66, 2_100),
  surprised: subtleProfile(0.07, 0.05, 0.06, 0.55, 2_200),
};

/** Resolves a semantic state expression into Body-owned speech slots. */
export function createBodyStateExpressionAdapter(
  getBody: () => StateExpressionBody | null,
): StateExpressionSchedulerCallbacks {
  const ownedByUtterance = new Map<string, OwnedStateExpression>();

  const release = (utteranceId: string): void => {
    const owned = ownedByUtterance.get(utteranceId);
    if (!owned) return;
    ownedByUtterance.delete(utteranceId);
    if (owned.releaseTimer !== null) globalThis.clearTimeout(owned.releaseTimer);
    if (owned.moodActive) owned.body.releaseSpeechMood();
    owned.body.resetSpeechExpressionParams();
    owned.motion?.release(180);
  };

  return {
    onCue: (cue) => {
      release(cue.utteranceId);
      const body = getBody();
      if (!body) return;

      body.setSpeechExpressionParams(MICROEXPRESSION_PROFILES[cue.state]);
      const moodActive = acquireMood(body, cue);
      const motion = acquireGesture(body, cue);

      const owned: OwnedStateExpression = { body, moodActive, motion, releaseTimer: null };
      ownedByUtterance.set(cue.utteranceId, owned);
      if (cue.durationMs && cue.durationMs > 0) {
        owned.releaseTimer = globalThis.setTimeout(() => release(cue.utteranceId), cue.durationMs);
      }
    },
    onRelease: (utteranceId) => release(utteranceId),
  };
}

function acquireMood(body: StateExpressionBody, cue: StateExpressionCue): boolean {
  if (!cue.expression || cue.expression === "neutral") return false;
  body.setSpeechMood(cue.expression, cue.expressionWeight ?? 0.3);
  return true;
}

function subtleProfile(
  engagementBrowWeight: number,
  engagementEyeWeight: number,
  flickWeight: number,
  blinkProbability: number,
  refractoryMs: number,
): Partial<SpeechMicroexpressionParams> {
  return {
    engagementBrowWeight,
    engagementEyeWeight,
    flickWeight,
    blinkProbability,
    refractoryMs,
  };
}

function acquireGesture(body: StateExpressionBody, cue: StateExpressionCue): MotionHandle | null {
  const animation = cue.gestureIntent ? GESTURE_ANIMATION[cue.gestureIntent] : undefined;
  if (!animation) return null;
  return body.acquireMotionSlot({
    source: "system",
    priority: "speech-expression",
    animation,
    options: {
      fadeInMs: 160,
      fadeOutMs: 280,
      loop: false,
      weight: cue.intensity === "medium" ? 0.45 : 0.32,
    },
  });
}

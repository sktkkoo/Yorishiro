import type { Body, SemanticMotionHandle, SpeechStateExpressionHandle } from "../../core/body";
import type { SpeechMicroexpressionParams } from "../../core/body/speech-microexpression-system";
import type { StateExpressionSchedulerCallbacks } from "./scheduler";
import type { GroundedAgentState, StateExpressionCue } from "./types";

type StateExpressionBody = Pick<
  Body,
  "acquireSemanticMotion" | "acquireSpeechStateExpression" | "setMotionConversationPhase"
>;

interface OwnedStateExpression {
  readonly body: StateExpressionBody;
  state: SpeechStateExpressionHandle | null;
  motion: SemanticMotionHandle | null;
  releaseTimer: ReturnType<typeof globalThis.setTimeout> | null;
  audioCompleted: boolean;
}

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

  const release = (utteranceId: string, completed = false): void => {
    const owned = ownedByUtterance.get(utteranceId);
    if (!owned) return;
    if (owned.releaseTimer !== null) globalThis.clearTimeout(owned.releaseTimer);
    owned.releaseTimer = null;
    owned.state?.release();
    owned.state = null;
    if (completed && owned.motion?.finishAfterSpeech && owned.motion.isActive()) {
      // Only an explicitly reviewed short one-shot owns this recovery tail.
      // Keep the scheduler handle until its authored end; cancellation still wins.
      owned.audioCompleted = true;
      return;
    }
    ownedByUtterance.delete(utteranceId);
    owned.motion?.release(180);
  };

  const releaseCompletedMotions = (): void => {
    for (const [utteranceId, owned] of ownedByUtterance) {
      if (owned.audioCompleted) release(utteranceId);
    }
  };

  return {
    onConversationPhaseChange: (phase) => {
      if (phase !== "idle") releaseCompletedMotions();
      getBody()?.setMotionConversationPhase(phase);
    },
    onCue: (cue) => {
      releaseCompletedMotions();
      const body = getBody();
      if (!body) {
        release(cue.utteranceId);
        return;
      }
      const previous = ownedByUtterance.get(cue.utteranceId);
      if (previous?.releaseTimer !== null && previous?.releaseTimer !== undefined) {
        globalThis.clearTimeout(previous.releaseTimer);
      }

      // Install the new facial layer before releasing the old one, so a cue
      // update does not briefly restart the speech mood's release envelope.
      const state = body.acquireSpeechStateExpression({
        preset: cue.expression,
        intensity: cue.expressionWeight,
        microexpressionParams: MICROEXPRESSION_PROFILES[cue.state],
      });
      const replacement = acquireGesture(body, cue);
      // Facial updates and gesture cooldowns do not cancel an authored motion.
      // `none` means no additional gesture. The player bounds long recordings
      // separately from face expiry; reviewed short one-shots can finish a return.
      const canContinue = previous?.body === body && previous.motion?.isActive();
      const motion = replacement ?? (canContinue ? previous.motion : null);
      previous?.state?.release();
      if (previous?.motion !== motion) previous?.motion?.release(180);

      const owned: OwnedStateExpression = {
        body,
        state,
        motion,
        releaseTimer: null,
        audioCompleted: false,
      };
      ownedByUtterance.set(cue.utteranceId, owned);
      if (motion && motion !== previous?.motion) {
        void motion.completion.then(() => {
          const current = ownedByUtterance.get(cue.utteranceId);
          if (current?.motion !== motion) return;
          current.motion = null;
          if (current.state === null) ownedByUtterance.delete(cue.utteranceId);
        });
      }
      if (cue.durationMs && cue.durationMs > 0) {
        owned.releaseTimer = globalThis.setTimeout(() => {
          if (ownedByUtterance.get(cue.utteranceId) !== owned) return;
          owned.releaseTimer = null;
          owned.state?.release();
          owned.state = null;
          if (!owned.motion?.isActive()) ownedByUtterance.delete(cue.utteranceId);
        }, cue.durationMs);
      }
    },
    onRelease: (utteranceId, reason) => release(utteranceId, reason === "completed"),
  };
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

function acquireGesture(
  body: StateExpressionBody,
  cue: StateExpressionCue,
): SemanticMotionHandle | null {
  if (!cue.gestureIntent || cue.gestureIntent === "none") return null;
  return body.acquireSemanticMotion({
    source: "system",
    priority: "speech-expression",
    intent: cue.gestureIntent,
    context: "speech",
    intensity: cue.intensity === "medium" ? 0.65 : 0.35,
  });
}

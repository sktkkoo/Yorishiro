import type { ExpressionHandle, MotionHandle } from "@yorishiro/sdk";
import type { Body } from "../../core/body";
import type { PerformanceCueSchedulerCallbacks } from "./scheduler";
import type { PerformanceCue, PerformanceGestureIntent } from "./types";

type PerformanceCueBody = Pick<Body, "acquireExpressionSlot" | "acquireMotionSlot">;

interface OwnedPerformance {
  expression: ExpressionHandle | null;
  motion: MotionHandle | null;
  releaseTimer: ReturnType<typeof globalThis.setTimeout> | null;
}

const GESTURE_ANIMATION: Readonly<Partial<Record<PerformanceGestureIntent, string>>> = {
  agree: "anim:VRMA_small_nod",
  consider: "anim:VRMA_head_tilt_down",
  reassure: "anim:VRMA_small_nod",
  emphasize: "anim:VRMA_small_nod",
};

/** semantic cue を現在の Body が持つ発話演技専用 slot へ変換する。 */
export function createBodyPerformanceCueAdapter(
  getBody: () => PerformanceCueBody | null,
): PerformanceCueSchedulerCallbacks {
  const ownedByUtterance = new Map<string, OwnedPerformance>();

  const release = (utteranceId: string): void => {
    const owned = ownedByUtterance.get(utteranceId);
    if (!owned) return;
    ownedByUtterance.delete(utteranceId);
    if (owned.releaseTimer !== null) globalThis.clearTimeout(owned.releaseTimer);
    owned.expression?.release();
    owned.motion?.release(180);
  };

  return {
    onCue: (cue) => {
      release(cue.utteranceId);
      const body = getBody();
      if (!body) return;

      const expression = acquireExpression(body, cue);
      const motion = acquireGesture(body, cue);
      if (!expression && !motion) return;

      const owned: OwnedPerformance = { expression, motion, releaseTimer: null };
      ownedByUtterance.set(cue.utteranceId, owned);
      if (cue.durationMs && cue.durationMs > 0) {
        owned.releaseTimer = globalThis.setTimeout(() => release(cue.utteranceId), cue.durationMs);
      }
    },
    onRelease: (utteranceId) => release(utteranceId),
  };
}

function acquireExpression(body: PerformanceCueBody, cue: PerformanceCue): ExpressionHandle | null {
  if (!cue.expression || cue.expression === "neutral") return null;
  return body.acquireExpressionSlot("speech", "mood", cue.expression, cue.expressionWeight ?? 0.3);
}

function acquireGesture(body: PerformanceCueBody, cue: PerformanceCue): MotionHandle | null {
  const animation = cue.gestureIntent ? GESTURE_ANIMATION[cue.gestureIntent] : undefined;
  if (!animation) return null;
  return body.acquireMotionSlot({
    source: "system",
    priority: "speech-performance",
    animation,
    options: {
      fadeInMs: 160,
      fadeOutMs: 280,
      loop: false,
      weight: cue.intensity === "medium" ? 0.45 : 0.32,
    },
  });
}

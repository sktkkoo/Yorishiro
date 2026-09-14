import type { VoiceSpeechLifecycleCallbacks } from "../../core/voice/voice-player";
import {
  createStateExpressionResolverState,
  finishAssistantTranscript,
  resolveAssistantTranscriptDelta,
} from "./resolver";
import {
  type StateExpressionClock,
  StateExpressionScheduler,
  type StateExpressionSchedulerCallbacks,
} from "./scheduler";
import type { StateExpressionCue } from "./types";

/**
 * Provider-independent TTS side channel. Parsing is local and leaves text intact.
 * Prepared cues stay cached until Web Audio reports the actual playout start;
 * queued synthesis must not take expression ownership from audible speech.
 * VoicePlayer imports only a callback interface, so there is no core/runtime cycle.
 */
export function createVoiceStateExpressionBridge(
  callbacks: StateExpressionSchedulerCallbacks,
  clock?: StateExpressionClock,
): VoiceSpeechLifecycleCallbacks {
  const scheduler = new StateExpressionScheduler(callbacks, undefined, clock);
  const prepared = new Map<string, readonly StateExpressionCue[]>();
  let activeId: string | null = null;
  let pendingId: string | null = null;
  let completedId: string | null = null;

  const releaseCompleted = (reason: "cancelled" | "replaced"): void => {
    const id = completedId;
    completedId = null;
    if (id !== null) callbacks.onRelease(id, reason);
  };

  return {
    onPrepared: (utteranceId, text) => {
      releaseCompleted("replaced");
      const resolution = resolveAssistantTranscriptDelta(createStateExpressionResolverState(), {
        utteranceId,
        delta: text,
        phase: "assistant-responding",
      });
      const tail = finishAssistantTranscript(resolution.state, {
        utteranceId,
        phase: "assistant-responding",
      });
      if (pendingId !== null && pendingId !== activeId) prepared.delete(pendingId);
      prepared.set(utteranceId, [...resolution.cues, ...tail.cues]);
      pendingId = utteranceId;
      if (activeId === null) callbacks.onConversationPhaseChange?.("assistant-responding");
    },
    onStarted: (utteranceId, startedAtMs) => {
      const cues = prepared.get(utteranceId);
      if (!cues || !Number.isFinite(startedAtMs)) return;
      activeId = utteranceId;
      if (pendingId === utteranceId) pendingId = null;
      callbacks.onConversationPhaseChange?.("assistant-speaking");
      scheduler.prepareUtterance(utteranceId);
      for (const cue of cues) scheduler.schedule(cue);
      scheduler.startUtterance(utteranceId, startedAtMs);
    },
    onEnded: (utteranceId, reason) => {
      prepared.delete(utteranceId);
      const wasPending = pendingId === utteranceId;
      if (wasPending) pendingId = null;
      if (activeId === utteranceId) {
        activeId = null;
        if (reason === "completed") {
          completedId = utteranceId;
          scheduler.completeUtterance(utteranceId);
        } else scheduler.cancelUtterance(utteranceId);
      } else if (!wasPending) {
        return;
      }
      if (activeId !== null) return;
      callbacks.onConversationPhaseChange?.(pendingId ? "assistant-responding" : "idle");
    },
    // Do not emit a phase here: another audio owner may already control Body.
    // Only this bridge's most recent naturally completed utterance can be released.
    onInvalidated: () => releaseCompleted("cancelled"),
  };
}

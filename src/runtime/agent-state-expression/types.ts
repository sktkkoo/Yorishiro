/** Provider- and avatar-independent facial state preset for realtime speech. */
export type StateExpressionPreset = "neutral" | "relaxed" | "happy" | "sad" | "surprised";

/** Conversational or cognitive state explicitly grounded in the assistant output. */
export type GroundedAgentState =
  | "acknowledging"
  | "appreciative"
  | "concerned"
  | "considering"
  | "discovering"
  | "emphatic"
  | "progressing"
  | "reassuring"
  | "surprised";

/** Semantic body intent resolved to a concrete motion by the runtime. */
export type StateExpressionGestureIntent = "agree" | "consider" | "reassure" | "emphasize" | "none";

/**
 * Semantic state expression relative to remote speech start.
 * It travels separately from spoken text and contains no animation or morph names.
 */
export interface StateExpressionCue {
  readonly utteranceId: string;
  readonly atMs: number;
  readonly state: GroundedAgentState;
  readonly expression?: StateExpressionPreset;
  readonly expressionWeight?: number;
  readonly gestureIntent?: StateExpressionGestureIntent;
  readonly intensity?: "small" | "medium";
  readonly durationMs?: number;
}

/** Conversation phase normalized from provider-specific events by the adapter. */
export type StateExpressionConversationPhase =
  | "idle"
  | "user-speaking"
  | "assistant-responding"
  | "assistant-speaking"
  | "interrupted"
  | "disconnected";

/** Provider-neutral integration boundary for assistant transcript deltas. */
export interface AssistantTranscriptDelta {
  readonly utteranceId: string;
  readonly delta: string;
  readonly phase: StateExpressionConversationPhase;
}

/** Flushes only the pending transcript tail without replaying completed text. */
export interface AssistantTranscriptDone {
  readonly utteranceId: string;
  readonly phase: StateExpressionConversationPhase;
}

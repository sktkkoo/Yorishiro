/** Realtime Voice の発話に添える、avatar 非依存の演技意図。 */
export type PerformanceExpression = "neutral" | "relaxed" | "happy" | "sad" | "surprised";

/** 実 animation 名ではなく、runtime が motion catalog へ解決する意味 tag。 */
export type PerformanceGestureIntent = "agree" | "consider" | "reassure" | "emphasize" | "none";

/**
 * remote speech start を 0 とする semantic performance cue。
 * spoken text とは別 channel で運び、animation / morph の固有名は含めない。
 */
export interface PerformanceCue {
  readonly utteranceId: string;
  readonly atMs: number;
  readonly expression?: PerformanceExpression;
  readonly expressionWeight?: number;
  readonly gestureIntent?: PerformanceGestureIntent;
  readonly intensity?: "small" | "medium";
  readonly durationMs?: number;
}

/** transcript delta 到着時の会話状態。adapter 側で upstream event から正規化する。 */
export type PerformanceConversationPhase =
  | "idle"
  | "user-speaking"
  | "assistant-responding"
  | "assistant-speaking"
  | "interrupted"
  | "disconnected";

/** assistant transcript だけを渡す integration boundary。 */
export interface AssistantTranscriptDelta {
  readonly utteranceId: string;
  readonly delta: string;
  readonly phase: PerformanceConversationPhase;
}

/** transcript/done の text を再投入せず、未確定の末尾だけを flush する境界。 */
export interface AssistantTranscriptDone {
  readonly utteranceId: string;
  readonly phase: PerformanceConversationPhase;
}

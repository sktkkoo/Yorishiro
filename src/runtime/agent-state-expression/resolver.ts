import type {
  AssistantTranscriptDelta,
  AssistantTranscriptDone,
  GroundedAgentState,
  StateExpressionCue,
  StateExpressionGestureIntent,
  StateExpressionPreset,
} from "./types";

export interface StateExpressionResolverState {
  readonly utteranceId: string | null;
  readonly pendingText: string;
  readonly elapsedSpeechMs: number;
}

export interface StateExpressionResolution {
  readonly state: StateExpressionResolverState;
  readonly cues: ReadonlyArray<StateExpressionCue>;
}

interface SemanticStateExpression {
  readonly state: GroundedAgentState;
  readonly expression: StateExpressionPreset;
  readonly expressionWeight: number;
  readonly gestureIntent: StateExpressionGestureIntent;
  readonly intensity: "small" | "medium";
  readonly durationMs: number;
}

const INITIAL_STATE: StateExpressionResolverState = {
  utteranceId: null,
  pendingText: "",
  elapsedSpeechMs: 0,
};

const EXPRESSION_LEAD_MS = 100;
const CJK_CHARACTER_MS = 90;
const LATIN_WORD_MS = 260;
const PUNCTUATION_PAUSE_MS = 120;

// Use explicit grounded vocabulary instead of unconstrained sentiment inference.
const APOLOGY_PATTERN =
  /(?:ごめん|すみません|申し訳|残念|失敗しました|\b(?:sorry|apolog(?:y|ize|ise)|regret)\b)/iu;
const CONCERN_PATTERN =
  /(?:難し|困(?:った|難)|懸念|慎重|不確実|不明|リスク|問題|注意が必要|できません|\b(?:difficult|uncertain|concern|risk|problem|careful|cannot|can't)\b)/iu;
const SURPRISE_PATTERN =
  /(?:びっくり|驚(?:いた|きました)|まさか|本当に[？?!！]|\b(?:surpris(?:e|ed|ing)|unexpected)\b)/iu;
const APPRECIATION_PATTERN =
  /(?:ありがとう|嬉しい|うれしい|よかった|良かった|いいね|素晴らしい|\b(?:thank(?:s| you)?|glad|delighted|wonderful)\b)/iu;
const REASSURE_PATTERN =
  /(?:大丈夫|安心して|任せて|心配(?:しないで|いらない)|問題ない|対応でき(?:る|ます)|\b(?:rest assured|no problem|don't worry|can handle)\b)/iu;
const DISCOVERY_PATTERN =
  /(?:見つけました|見つかりました|判明しました|分かりました|わかりました|確認できました|原因は|\b(?:found|discovered|confirmed|turns out)\b)/iu;
const AGREE_PATTERN =
  /(?:^|[\s、，])(?:うん|はい|そうですね|その通り|了解|agreed|exactly)(?:[\s、，。.!！?？]|$)/iu;
const CONSIDER_PATTERN =
  /(?:確認(?:する|します)|調べ(?:る|ます)|考え(?:る|ます)|かもしれない|可能性|一方で|ただし|まずは|\b(?:check|investigate|consider|possibly|perhaps|however|first)\b)/iu;
const EMPHASIZE_PATTERN =
  /(?:重要|必ず|注意|ポイント|つまり|結論として|\b(?:important|must|key point|in short|the conclusion)\b)/iu;
const PROGRESS_PATTERN =
  /(?:確認しました|読みました|更新しました|修正しました|実行しました|進めます|次に|これから|対応します|\b(?:checked|updated|fixed|completed|next|proceeding)\b)/iu;

export function createStateExpressionResolverState(): StateExpressionResolverState {
  return INITIAL_STATE;
}

/**
 * assistant transcript delta を節単位で畳み、限定的な semantic cue へ解決する pure reducer。
 * chunk の切れ目には依存せず、句読点または transcript/done まで発火を保留する。
 */
export function resolveAssistantTranscriptDelta(
  previous: StateExpressionResolverState,
  input: AssistantTranscriptDelta,
): StateExpressionResolution {
  return resolveTranscript(previous, input, false);
}

/** transcript/done では done.text を再投入せず、delta で残った末尾だけを確定する。 */
export function finishAssistantTranscript(
  previous: StateExpressionResolverState,
  input: AssistantTranscriptDone,
): StateExpressionResolution {
  return resolveTranscript(previous, { ...input, delta: "" }, true);
}

function resolveTranscript(
  previous: StateExpressionResolverState,
  input: AssistantTranscriptDelta,
  flushRemainder: boolean,
): StateExpressionResolution {
  if (!isAssistantOutputPhase(input.phase)) {
    return { state: INITIAL_STATE, cues: [] };
  }

  const state =
    previous.utteranceId === input.utteranceId
      ? previous
      : {
          utteranceId: input.utteranceId,
          pendingText: "",
          elapsedSpeechMs: 0,
        };
  const combined = state.pendingText + input.delta;
  const { clauses, remainder } = splitCompletedClauses(combined, flushRemainder);
  const cues: StateExpressionCue[] = [];
  let elapsedSpeechMs = state.elapsedSpeechMs;

  for (const clause of clauses) {
    const clauseDurationMs = estimateSpeechDurationMs(clause);
    const semantic = classifyClause(clause);
    if (semantic) {
      cues.push({
        utteranceId: input.utteranceId,
        // 意味が確定する節末を基準にする。節頭へ置くと delta 到着時には
        // 長い節ほど maxLateMs を越え、ほぼ必ず skip されてしまう。
        atMs: Math.max(0, elapsedSpeechMs + clauseDurationMs - EXPRESSION_LEAD_MS),
        state: semantic.state,
        expression: semantic.expression,
        expressionWeight: semantic.expressionWeight,
        gestureIntent: semantic.gestureIntent,
        intensity: semantic.intensity,
        durationMs: semantic.durationMs,
      });
    }
    elapsedSpeechMs += clauseDurationMs;
  }

  return {
    state: {
      utteranceId: input.utteranceId,
      pendingText: remainder,
      elapsedSpeechMs,
    },
    cues,
  };
}

function isAssistantOutputPhase(phase: AssistantTranscriptDelta["phase"]): boolean {
  return phase === "assistant-responding" || phase === "assistant-speaking";
}

function splitCompletedClauses(
  text: string,
  flushRemainder: boolean,
): { readonly clauses: ReadonlyArray<string>; readonly remainder: string } {
  const clauses: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!/[。！？!?\n]/u.test(text[index])) continue;
    clauses.push(text.slice(start, index + 1));
    start = index + 1;
  }

  const remainder = text.slice(start);
  if (flushRemainder && remainder.trim().length > 0) {
    clauses.push(remainder);
    return { clauses, remainder: "" };
  }
  return { clauses, remainder };
}

function classifyClause(clause: string): SemanticStateExpression | null {
  const normalized = clause.trim();
  if (normalized.length === 0) return null;

  if (APOLOGY_PATTERN.test(normalized)) {
    return stateExpression("concerned", "sad", 0.57, "none", "medium", 2_800);
  }
  if (SURPRISE_PATTERN.test(normalized)) {
    return stateExpression("surprised", "surprised", 0.54, "none", "medium", 2_200);
  }
  if (APPRECIATION_PATTERN.test(normalized)) {
    return stateExpression("appreciative", "happy", 0.6, "none", "medium", 2_600);
  }
  if (REASSURE_PATTERN.test(normalized)) {
    return stateExpression("reassuring", "relaxed", 0.5, "reassure", "small", 2_800);
  }
  if (CONCERN_PATTERN.test(normalized)) {
    return stateExpression("concerned", "sad", 0.36, "consider", "small", 3_200);
  }
  if (DISCOVERY_PATTERN.test(normalized)) {
    return stateExpression("discovering", "surprised", 0.33, "none", "small", 2_400);
  }
  if (AGREE_PATTERN.test(normalized)) {
    return stateExpression("acknowledging", "relaxed", 0.33, "agree", "small", 2_200);
  }
  if (CONSIDER_PATTERN.test(normalized)) {
    return stateExpression("considering", "neutral", 0, "consider", "small", 3_200);
  }
  if (EMPHASIZE_PATTERN.test(normalized)) {
    return stateExpression("emphatic", "neutral", 0, "emphasize", "medium", 2_200);
  }
  if (PROGRESS_PATTERN.test(normalized)) {
    return stateExpression("progressing", "neutral", 0, "none", "small", 2_400);
  }
  return null;
}

function stateExpression(
  state: GroundedAgentState,
  expression: StateExpressionPreset,
  expressionWeight: number,
  gestureIntent: StateExpressionGestureIntent,
  intensity: "small" | "medium",
  durationMs: number,
): SemanticStateExpression {
  return { state, expression, expressionWeight, gestureIntent, intensity, durationMs };
}

function estimateSpeechDurationMs(text: string): number {
  const cjkCount = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? [])
    .length;
  const latinWords = text.match(/[\p{Script=Latin}\p{Number}]+/gu)?.length ?? 0;
  const punctuationCount = text.match(/[、，。！？!?;；:：]/gu)?.length ?? 0;
  return (
    cjkCount * CJK_CHARACTER_MS +
    latinWords * LATIN_WORD_MS +
    punctuationCount * PUNCTUATION_PAUSE_MS
  );
}

import type {
  AssistantTranscriptDelta,
  AssistantTranscriptDone,
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

// 誤発火を抑えるため、自由な sentiment 推定ではなく限定語彙だけを扱う。
const APOLOGY_PATTERN = /(?:ごめん|すみません|申し訳|残念|失敗しました|できません)/u;
const SURPRISE_PATTERN = /(?:びっくり|驚(?:いた|きました)|まさか|本当に[？?!！])/u;
const HAPPY_PATTERN = /(?:ありがとう|嬉しい|うれしい|よかった|良かった|いいね|素晴らしい)/u;
const REASSURE_PATTERN =
  /(?:大丈夫|安心して|任せて|心配(?:しないで|いらない)|問題ない|対応でき(?:る|ます))/u;
const AGREE_PATTERN =
  /(?:^|[\s、，])(?:うん|はい|そうですね|その通り|了解)(?:[\s、，。.!！?？]|$)/u;
const CONSIDER_PATTERN =
  /(?:確認(?:する|します)|調べ(?:る|ます)|考え(?:る|ます)|かもしれない|可能性|一方で|ただし|まずは)/u;
const EMPHASIZE_PATTERN = /(?:重要|必ず|注意|ポイント|つまり|結論として)/u;

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
    return stateExpression("sad", 0.42, "none", "small", 1_500);
  }
  if (SURPRISE_PATTERN.test(normalized)) {
    return stateExpression("surprised", 0.38, "none", "small", 1_100);
  }
  if (HAPPY_PATTERN.test(normalized)) {
    return stateExpression("happy", 0.45, "none", "small", 1_500);
  }
  if (REASSURE_PATTERN.test(normalized)) {
    return stateExpression("relaxed", 0.36, "reassure", "small", 1_600);
  }
  if (AGREE_PATTERN.test(normalized)) {
    return stateExpression("relaxed", 0.3, "agree", "small", 1_200);
  }
  if (CONSIDER_PATTERN.test(normalized)) {
    return stateExpression("neutral", 0.24, "consider", "small", 1_500);
  }
  if (EMPHASIZE_PATTERN.test(normalized)) {
    return stateExpression("neutral", 0.28, "emphasize", "small", 1_300);
  }
  return null;
}

function stateExpression(
  expression: StateExpressionPreset,
  expressionWeight: number,
  gestureIntent: StateExpressionGestureIntent,
  intensity: "small" | "medium",
  durationMs: number,
): SemanticStateExpression {
  return { expression, expressionWeight, gestureIntent, intensity, durationMs };
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

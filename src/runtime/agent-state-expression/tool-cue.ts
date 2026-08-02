import type {
  GroundedAgentState,
  StateExpressionGestureIntent,
  StateExpressionPreset,
} from "./types";

/** model-authored tool cue を具体的な表情値へ解決する host 側固定 mapping。 */
export interface GroundedStateCueTemplate {
  readonly expression: StateExpressionPreset;
  readonly expressionWeight: number;
  readonly gestureIntent: StateExpressionGestureIntent;
  readonly intensity: "small" | "medium";
  readonly durationMs: number;
}

// 値は resolver の phrase mapping と揃える。model は grounded state だけを選び、
// 表情の重み・時間はここで管理する。感触は実機で帰納的に調整する。
const GROUNDED_STATE_CUE_TEMPLATES: Record<GroundedAgentState, GroundedStateCueTemplate> = {
  acknowledging: template("relaxed", 0.22, "agree", "small", 2_200),
  appreciative: template("happy", 0.4, "none", "medium", 2_600),
  concerned: template("sad", 0.24, "consider", "small", 3_200),
  considering: template("neutral", 0, "consider", "small", 3_200),
  discovering: template("surprised", 0.22, "none", "small", 2_400),
  emphatic: template("neutral", 0, "emphasize", "medium", 2_200),
  progressing: template("neutral", 0, "none", "small", 2_400),
  reassuring: template("relaxed", 0.28, "reassure", "small", 2_800),
  surprised: template("surprised", 0.36, "none", "medium", 2_200),
};

/** function tool の enum 宣言と runtime 検証で共有する grounded state 一覧。 */
export const GROUNDED_AGENT_STATES = Object.keys(
  GROUNDED_STATE_CUE_TEMPLATES,
) as ReadonlyArray<GroundedAgentState>;

export function isGroundedAgentState(value: unknown): value is GroundedAgentState {
  return typeof value === "string" && value in GROUNDED_STATE_CUE_TEMPLATES;
}

export function groundedStateCueTemplate(state: GroundedAgentState): GroundedStateCueTemplate {
  return GROUNDED_STATE_CUE_TEMPLATES[state];
}

function template(
  expression: StateExpressionPreset,
  expressionWeight: number,
  gestureIntent: StateExpressionGestureIntent,
  intensity: "small" | "medium",
  durationMs: number,
): GroundedStateCueTemplate {
  return { expression, expressionWeight, gestureIntent, intensity, durationMs };
}

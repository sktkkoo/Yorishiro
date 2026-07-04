import type { WorkspaceAttentionAggregate, WorkspaceAttentionMood } from "./types";

/**
 * 照明 = workspace 全体状態を伝える「天気」層（presence の 3 層で最も控えめ・最も遅い）。
 *
 * この module は `WorkspaceAttentionAggregate`（mood/severity の集約）だけを読み、
 * scene が baseline に対してどう傾けるかを表す正規化 modifier に落とす純関数を提供する。
 * item 列は読まない（aggregate-only）。実際の色温度・強度の絶対値は scene が所有する
 * ——ここが返すのは「baseline をどちら向きにどれだけ寄せるか」の相対値だけで、
 * scene が強く出すか・淡く出すか・出さないかを最終決定する（scene ownership を壊さない）。
 *
 * design-record: 2026-06-21-inhabited-workspace-design.md §4「照明（P1 experiment）」
 * 関連: docs/decisions/scene-controls-api.md（lighting = Scene ownership）
 */
export interface LightingMood {
  /** どの aggregate 状態に由来するか。scene が分岐に使える。 */
  readonly tone: WorkspaceAttentionMood;

  /**
   * 色温度の寄せ先。0 = 冷たい、0.5 = neutral、1 = 暖かい。
   * scene は自身の warm/cool 端の間をこの値で lerp する想定。
   */
  readonly warmth: number;

  /**
   * 明るさの寄せ先。0 = 暗い、0.5 = neutral、1 = 明るい。
   * baseline 比の相対値で、scene が自身の intensity レンジに map する。
   */
  readonly brightness: number;
}

/**
 * calm（item なし）の baseline。default 不変の契約：calm のとき scene の見た目を
 * 一切歪めない（warmth/brightness ともに neutral 中点 0.5）。
 */
export const NEUTRAL_LIGHTING_MOOD: LightingMood = {
  tone: "calm",
  warmth: 0.5,
  brightness: 0.5,
};

/**
 * 各 aggregate mood に対する出発点の照明バイアス。
 *
 * 値は spec の定性記述（§4 の 4 状態テーブル）を素直に写したもので、まだ調整前の
 * 出発点。subtle に保つため neutral 中点 0.5 からの振れ幅は小さく取る。実機観察で
 * 帰納的に詰める前提（inductive-tuning）。
 *
 * - calm    : 暖色・安定          → baseline のまま
 * - working : 安定した「稼働」     → baseline からほぼ動かさない（周辺視で気づかせない）
 * - waiting : わずかに明るく・ゆっくり → 明るさをわずかに上げる
 * - failed  : 少し暗く・冷たく     → 暗さ・冷たさへ振る
 */
const MOOD_BIAS: Record<WorkspaceAttentionMood, LightingMood> = {
  calm: NEUTRAL_LIGHTING_MOOD,
  working: { tone: "working", warmth: 0.52, brightness: 0.5 },
  waiting: { tone: "waiting", warmth: 0.5, brightness: 0.6 },
  failed: { tone: "failed", warmth: 0.38, brightness: 0.42 },
};

/**
 * aggregate → 照明 mood の純関数。
 *
 * aggregate.mood だけで分岐する（severity / activeCount は読まない）。これは「天気」が
 * 個々の item の重さではなく workspace 全体の概況だけを伝えるべきという §4 の方針による。
 */
export function lightingMoodFromAggregate(aggregate: WorkspaceAttentionAggregate): LightingMood {
  return MOOD_BIAS[aggregate.mood] ?? NEUTRAL_LIGHTING_MOOD;
}

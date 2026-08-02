/**
 * Expression intent policy — priority class / coexistence の declarative table。
 *
 * producer が arbitrary numeric priority を渡す API は作らない。class は
 * source / semantic role から導出し、順序はこのファイルの table だけが正本。
 * ExpressionManager の SOURCE_PRIORITY は migration 中の compatibility guard
 * として残るが、新しい region / semantic policy はこちらにだけ足す。
 *
 * 設計正本: docs/decisions/expression-intent-arbitration.md §4
 */

import type {
  ExpressionIntent,
  ExpressionOccupancy,
  ExpressionSemantic,
} from "./expression-intent";
import type { ExpressionSource } from "./expression-manager";

/**
 * 固定 priority class。数値でなく名前で扱い、順序は RANK table が持つ。
 *
 * ordinary-reflex は decision doc の表には明示されないが、現
 * ExpressionManager の `reflex` source（auto blink 等の生理層）に対応する。
 * M0 golden test「mcp / system は reflex に譲る」を保つため
 * explicit-external より上に置く。ただし eyelid/physiology lane 内の
 * 「explicit eyelid action 中は ordinary auto-blink が suspend される」は
 * class rank と別の lane 内 precedence（PHYSIOLOGY_PRECEDENCE）で扱う。
 */
export type ExpressionPriorityClass =
  | "ambient-baseline"
  | "grounded-activity"
  | "grounded-conversation"
  | "explicit-persona"
  | "explicit-external"
  | "ordinary-reflex"
  | "safety-reflex";

/** affect lane の overlap 比較に使う class 順位。大きいほど優先。 */
export const EXPRESSION_PRIORITY_CLASS_RANK: Record<ExpressionPriorityClass, number> = {
  "ambient-baseline": 0,
  "grounded-activity": 1,
  "grounded-conversation": 2,
  "explicit-persona": 3,
  "explicit-external": 4,
  "ordinary-reflex": 5,
  "safety-reflex": 6,
};

/**
 * source + semantic role から priority class を導出する。
 * salience は class を直接決めず、ambient guard（下記）の適用判定に使う。
 */
export function deriveExpressionPriorityClass(
  source: ExpressionSource,
  semantic: ExpressionSemantic,
): ExpressionPriorityClass {
  if (semantic.role === "safety-reflex") return "safety-reflex";
  switch (source) {
    case "mcp":
    case "system":
      return "explicit-external";
    case "persona":
      return "explicit-persona";
    case "speech":
      return "grounded-conversation";
    case "thinking":
      return "grounded-activity";
    case "idle":
      return "ambient-baseline";
    case "reflex":
      return "ordinary-reflex";
  }
}

/**
 * eyelid/physiology lane 内の precedence。大きいほど優先。
 *
 * class rank と逆転がある点に注意：現挙動では idle squint episode が
 * ordinary auto-blink を中断する（EyelidExpressionController が squint 中は
 * blink slot を 0 にし suppression token を取る）。squint は ambient class
 * だが、physiology lane 内では「進行中の生理 episode が baseline reflex に
 * 優先する」ため、この lane だけ role ベースの独立 precedence を持つ。
 *
 * - safety-reflex: documented highest priority（意識を上書きする反射）
 * - explicit-action: 明示的な eyelid 操作。ordinary auto-blink を suspend する
 * - ambient episode (idle squint): baseline reflex より優先
 * - baseline reflex (ordinary auto-blink): 最下位
 */
export function derivePhysiologyPrecedence(
  source: ExpressionSource,
  semantic: ExpressionSemantic,
): number {
  if (semantic.role === "safety-reflex") return 3;
  if (semantic.role === "explicit-action") return 2;
  if (source === "idle") return 1;
  return 0;
}

/**
 * 2 intent の occupancy が競合するか判定し、競合する最初の
 * (region, lane) を返す。競合しなければ null。
 *
 * 競合は同 region + 同 lane のみ。articulation lane は #83 では予約のみで、
 * expression intent が互いに suppress する対象にしない（lip-sync viseme の
 * 将来 seam。docs/decisions/expression-intent-arbitration.md §3）。
 */
export function findOccupancyConflict(
  a: ReadonlyArray<ExpressionOccupancy>,
  b: ReadonlyArray<ExpressionOccupancy>,
): ExpressionOccupancy | null {
  for (const oa of a) {
    if (oa.lane === "articulation") continue;
    for (const ob of b) {
      if (ob.lane === "articulation") continue;
      if (oa.region === ob.region && oa.lane === ob.lane) return oa;
    }
  }
  return null;
}

/**
 * 同 class 別 owner の overlap を categorical（exclusive latest-wins）として
 * 扱うか判定する。
 *
 * - grounded-state / explicit-action 同士で occupancy が同一集合なら
 *   exclusive：mood preset のような categorical choice は 1 つに定まるべきで、
 *   deterministic に新しい方が勝つ（reason: exclusive-tie-lost）
 * - baseline を含む pair は blend：idle の state base + microvariation の
 *   並存（現挙動）を保つ
 */
export function isExclusiveCategoricalPair(a: ExpressionIntent, b: ExpressionIntent): boolean {
  const categorical = (role: ExpressionSemantic["role"]): boolean =>
    role === "grounded-state" || role === "explicit-action";
  if (!categorical(a.semantic.role) || !categorical(b.semantic.role)) return false;
  return occupancySetsEqual(a.occupancy, b.occupancy);
}

function occupancySetsEqual(
  a: ReadonlyArray<ExpressionOccupancy>,
  b: ReadonlyArray<ExpressionOccupancy>,
): boolean {
  if (a.length !== b.length) return false;
  for (const oa of a) {
    if (!b.some((ob) => ob.region === oa.region && ob.lane === oa.lane)) return false;
  }
  return true;
}

/**
 * ambient producer の制約。violation なら reason 文字列を返す。
 *
 * ambient は grounded-state / explicit-action を発行できず、semantic.state
 * （意味状態の主張）も持てない。ambient の許される表現は target 直指定の
 * baseline variation だけで、「強い emotion category の発明」を型で防ぐ。
 * intensity / timing の弱さは各 producer の感触 parameter（帰納調整）に
 * 委ね、ここでは category 制約のみ enforce する。将来外部 ambient producer
 * を受ける場合は、ここに microvariation target の allowlist を足す。
 */
export function findAmbientPolicyViolation(intent: {
  readonly salience: ExpressionIntent["salience"];
  readonly semantic: ExpressionSemantic;
}): "role" | "state" | null {
  if (intent.salience !== "ambient") return null;
  if (intent.semantic.role !== "baseline") return "role";
  if (intent.semantic.state !== undefined) return "state";
  return null;
}

// ─── occupancy 定型 ──────────────────────────────────────
//
// producer / resolver が使い回す定型の occupancy 集合。full-face preset は
// brow / eye / mouth の affect 3 region に展開する（decision doc §3）。
// eyelid は含めない：mood と blink は共存する。

/** full-face mood preset の occupancy（brow / eye / mouth の affect）。 */
export const FULL_FACE_AFFECT_OCCUPANCY: ReadonlyArray<ExpressionOccupancy> = [
  { region: "brow", lane: "affect" },
  { region: "eye", lane: "affect" },
  { region: "mouth", lane: "affect" },
];

/** blink / squint / eyelid reflex の occupancy。 */
export const EYELID_PHYSIOLOGY_OCCUPANCY: ReadonlyArray<ExpressionOccupancy> = [
  { region: "eyelid", lane: "physiology" },
];

/** lip-sync viseme 用に予約する occupancy（#83 では suppress 対象外）。 */
export const MOUTH_ARTICULATION_OCCUPANCY: ReadonlyArray<ExpressionOccupancy> = [
  { region: "mouth", lane: "articulation" },
];

/** 単一 region の affect occupancy（part morph / 部分表情用）。 */
export const BROW_AFFECT_OCCUPANCY: ReadonlyArray<ExpressionOccupancy> = [
  { region: "brow", lane: "affect" },
];
export const EYE_AFFECT_OCCUPANCY: ReadonlyArray<ExpressionOccupancy> = [
  { region: "eye", lane: "affect" },
];
export const MOUTH_AFFECT_OCCUPANCY: ReadonlyArray<ExpressionOccupancy> = [
  { region: "mouth", lane: "affect" },
];

/**
 * region metadata の無い arbitrary morph 用の空 occupancy。conflict 判定に
 * 参加しない（誰も抑止せず・誰にも抑止されない）ので、legacy の
 * 「manager の kind 内 source priority だけが調停する」挙動がそのまま残る。
 * region を推測で分類しない（decision doc §2）ための明示的な逃がし。
 */
export const EMPTY_OCCUPANCY: ReadonlyArray<ExpressionOccupancy> = [];

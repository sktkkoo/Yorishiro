/**
 * Expression intent debug facade（#83 M6）。
 *
 * arbiter snapshot（policy 判定と reason）と ExpressionManager の slot
 * snapshot（requested / effective weight）を intentId で join し、
 * 「なぜこの結果になったか」を一望できる read-only view を作る。
 *
 * - `budget-scaled`: admitted なのに effective < requested（global weight
 *   budget の proportional scale-down が唯一の原因）
 * - `manager-suppressed`: admitted なのに effective 0（migration 中の
 *   compatibility source priority による同 kind 内抑止）
 *
 * この facade は制御判断を持たない。新しい manager にはしない
 * （decision doc §6）。
 */

import type {
  ExpressionArbitrationSnapshot,
  ExpressionIntentSnapshotEntry,
} from "./expression-intent";
import type { ExpressionKind, SlotSnapshot } from "./expression-manager";

/** intent 1 件に紐づく concrete contribution の観察形。 */
export interface ExpressionIntentContributionView {
  readonly kind: ExpressionKind;
  readonly expressionName: string;
  readonly requestedWeight: number;
  readonly effectiveWeight: number;
  /** effective が requested を下回った理由の説明（無ければ null）。 */
  readonly numericNote: "budget-scaled" | "manager-suppressed" | null;
}

/** arbiter entry + contribution join の 1 行。 */
export interface ExpressionIntentDebugEntry extends ExpressionIntentSnapshotEntry {
  readonly contributions: ReadonlyArray<ExpressionIntentContributionView>;
}

export interface ExpressionIntentDebugView {
  readonly intents: ReadonlyArray<ExpressionIntentDebugEntry>;
  /** intent 経路外の legacy slot（key なし）。migration の残量が見える。 */
  readonly legacySlots: ReadonlyArray<SlotSnapshot>;
}

const WEIGHT_EPSILON = 1e-6;

/**
 * arbiter snapshot と manager slot snapshot を join した debug view を作る。
 * 要求時のみ呼ぶ想定で、allocation は許容する。
 *
 * `unmappedIntentIds`（slot bridge が記録した、concrete contribution へ
 * 解決できなかった intent）を渡すと、該当 entry の reason を
 * `unmapped-target` として表示する。
 */
export function buildExpressionIntentDebugView(
  arbitration: ExpressionArbitrationSnapshot,
  slots: ReadonlyArray<SlotSnapshot>,
  unmappedIntentIds?: ReadonlySet<string>,
): ExpressionIntentDebugView {
  const slotsByIntent = new Map<string, SlotSnapshot[]>();
  const legacySlots: SlotSnapshot[] = [];
  for (const slot of slots) {
    if (slot.key === undefined) {
      legacySlots.push(slot);
      continue;
    }
    // keyed slot の key は `{intentId}:{kind}:{name}`（bridge が採番）
    const intentId = slot.key.split(":", 1)[0];
    if (!intentId) continue;
    const list = slotsByIntent.get(intentId);
    if (list) {
      list.push(slot);
    } else {
      slotsByIntent.set(intentId, [slot]);
    }
  }

  const intents = arbitration.intents.map((entry): ExpressionIntentDebugEntry => {
    const joined = slotsByIntent.get(entry.intentId) ?? [];
    const contributions = joined.map((slot): ExpressionIntentContributionView => {
      let numericNote: ExpressionIntentContributionView["numericNote"] = null;
      if (slot.requestedWeight > WEIGHT_EPSILON) {
        if (slot.effectiveWeight <= WEIGHT_EPSILON) {
          numericNote = "manager-suppressed";
        } else if (slot.effectiveWeight < slot.requestedWeight - WEIGHT_EPSILON) {
          numericNote = "budget-scaled";
        }
      }
      return {
        kind: slot.kind,
        expressionName: slot.expressionName,
        requestedWeight: slot.requestedWeight,
        effectiveWeight: slot.effectiveWeight,
        numericNote,
      };
    });
    const unmapped = unmappedIntentIds?.has(entry.intentId) === true;
    return {
      ...entry,
      reason: unmapped ? "unmapped-target" : entry.reason,
      contributions,
    };
  });

  return { intents, legacySlots };
}

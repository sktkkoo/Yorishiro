/**
 * Expression intent shadow comparison（#83 M2）。
 *
 * M2移行時に対象 producer を intent として並行登録（shadow）し、intent 経路が
 * 予測する contribution と legacy slot の実際を突き合わせて差分を debug log
 * に出すための純関数群。shadow 中は intent 側から VRM を駆動せず、
 * ExpressionManager に slot も作らない（二重 mixer を作らない）。
 *
 * M6 cutover後はlegacy producerが残らないためruntimeには接続しない。これは
 * migration/parity test harnessとして保持し、productionで二重owner・二重slotを
 * 作らない。再移行時にのみdev harnessから明示的に呼ぶ。
 */

import type { AdmittedExpressionIntent } from "./expression-intent";
import type { ExpressionIntentResolver } from "./expression-intent-resolver";
import type { ExpressionKind, ExpressionSource, SlotSnapshot } from "./expression-manager";

/** intent 経路が予測する contribution（shadow 比較の期待値側）。 */
export interface ShadowExpectation {
  readonly intentId: string;
  readonly source: ExpressionSource;
  readonly kind: ExpressionKind;
  readonly expressionName: string;
  readonly weight: number;
}

/** admitted intent 集合を resolver で展開して期待 contribution 一覧を作る。 */
export function collectShadowExpectations(
  admitted: ReadonlyArray<AdmittedExpressionIntent>,
  resolver: ExpressionIntentResolver,
): ShadowExpectation[] {
  const expectations: ShadowExpectation[] = [];
  for (const intent of admitted) {
    resolver.resolve(intent, (kind, expressionName, weight) => {
      expectations.push({
        intentId: intent.intentId,
        source: intent.source,
        kind,
        expressionName,
        weight,
      });
    });
  }
  return expectations;
}

/**
 * 期待 contribution と legacy slot snapshot の差分を人間可読な文字列で返す。
 * `slotFilter` で比較対象の legacy slot を絞る（shadow 登録していない
 * producer の slot を「intent 側に無い」と誤検出しないため）。
 */
export function diffShadowAgainstSlots(
  expected: ReadonlyArray<ShadowExpectation>,
  slots: ReadonlyArray<SlotSnapshot>,
  slotFilter: (slot: SlotSnapshot) => boolean,
  weightEpsilon = 1e-3,
): string[] {
  const diffs: string[] = [];
  const keyOf = (source: string, kind: string, name: string): string => `${source}/${kind}/${name}`;

  const expectedByKey = new Map<string, ShadowExpectation>();
  for (const exp of expected) {
    expectedByKey.set(keyOf(exp.source, exp.kind, exp.expressionName), exp);
  }

  const seen = new Set<string>();
  for (const slot of slots) {
    if (!slotFilter(slot)) continue;
    const key = keyOf(slot.source, slot.kind, slot.expressionName);
    seen.add(key);
    const exp = expectedByKey.get(key);
    if (!exp) {
      diffs.push(`legacy-only slot: ${key} weight=${slot.requestedWeight.toFixed(3)}`);
      continue;
    }
    if (Math.abs(exp.weight - slot.requestedWeight) > weightEpsilon) {
      diffs.push(
        `weight mismatch: ${key} legacy=${slot.requestedWeight.toFixed(3)} intent=${exp.weight.toFixed(3)}`,
      );
    }
  }
  for (const [key, exp] of expectedByKey) {
    if (!seen.has(key)) {
      diffs.push(`intent-only contribution: ${key} weight=${exp.weight.toFixed(3)}`);
    }
  }
  return diffs;
}

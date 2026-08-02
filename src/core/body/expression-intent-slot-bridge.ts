/**
 * ExpressionIntentSlotBridge — admitted intent の contribution を
 * ExpressionManager の keyed slot として差分反映する接続層。
 *
 * - intent ごとの manager slot ID はここだけが所有する。producer は slot ID
 *   や morph weight budget を知らない（decision doc §2）
 * - 1 intent が複数 contribution へ展開されても、release は arbiter の owner
 *   handle 一つで閉じる（admitted から消えた intent の slot をここが回収する）
 * - weight の合成・budget scale は行わない。それは ExpressionManager の責務
 */

import type { AdmittedExpressionIntent } from "./expression-intent";
import type { ContributionSink, ExpressionIntentResolver } from "./expression-intent-resolver";
import type { ExpressionKind, ExpressionManager } from "./expression-manager";

interface BridgedSlot {
  readonly slotId: number;
  weight: number;
  /** 今回の sync で admitted に現れたか（消えた slot の回収判定）。 */
  seen: boolean;
}

export class ExpressionIntentSlotBridge {
  private readonly manager: ExpressionManager;
  private readonly resolver: ExpressionIntentResolver;
  private readonly slotsByKey = new Map<string, BridgedSlot>();
  private readonly unmappedIntents = new Set<string>();
  /** sink closure を 1 度だけ確保するための現在処理中 intent。 */
  private currentIntent: AdmittedExpressionIntent | null = null;
  private readonly sink: ContributionSink = (kind, expressionName, requestedWeight) => {
    const intent = this.currentIntent;
    if (!intent) return;
    this.applyContribution(intent, kind, expressionName, requestedWeight);
  };

  constructor(manager: ExpressionManager, resolver: ExpressionIntentResolver) {
    this.manager = manager;
    this.resolver = resolver;
  }

  /**
   * admitted intent 集合を manager slot に同期する。毎 frame 呼ばれる想定で、
   * 変化のない slot には触れない。
   */
  sync(admitted: ReadonlyArray<AdmittedExpressionIntent>): void {
    for (const slot of this.slotsByKey.values()) slot.seen = false;
    this.unmappedIntents.clear();

    for (const intent of admitted) {
      this.currentIntent = intent;
      const resolved = this.resolver.resolve(intent, this.sink);
      if (!resolved) this.unmappedIntents.add(intent.intentId);
    }
    this.currentIntent = null;

    for (const [key, slot] of this.slotsByKey) {
      if (!slot.seen) {
        this.manager.removeSlot(slot.slotId);
        this.slotsByKey.delete(key);
      }
    }
  }

  /**
   * concrete contribution へ解決できなかった admitted intent の ID 集合。
   * debug facade が arbiter snapshot と join して `unmapped-target` を説明する。
   */
  getUnmappedIntentIds(): ReadonlySet<string> {
    return this.unmappedIntents;
  }

  /**
   * intent が現在 manager 上で持つ effective weight の合計（budget /
   * priority 適用後）。legacy ExpressionHandle.effectiveWeight の互換窓。
   * suppress されて slot が無い intent は 0。
   */
  getEffectiveWeightForIntent(intentId: string): number {
    const prefix = `${intentId}:`;
    let total = 0;
    for (const [key, slot] of this.slotsByKey) {
      if (key.startsWith(prefix)) total += this.manager.getEffectiveWeight(slot.slotId);
    }
    return total;
  }

  /** 管理中の keyed slot 数（テスト・debug 用）。 */
  get size(): number {
    return this.slotsByKey.size;
  }

  /** 全 keyed slot を解放する（dispose 経路用）。 */
  clear(): void {
    for (const slot of this.slotsByKey.values()) {
      this.manager.removeSlot(slot.slotId);
    }
    this.slotsByKey.clear();
    this.unmappedIntents.clear();
  }

  private applyContribution(
    intent: AdmittedExpressionIntent,
    kind: ExpressionKind,
    expressionName: string,
    requestedWeight: number,
  ): void {
    const key = `${intent.intentId}:${kind}:${expressionName}`;
    const existing = this.slotsByKey.get(key);
    if (existing) {
      existing.seen = true;
      if (existing.weight !== requestedWeight) {
        this.manager.setWeight(existing.slotId, requestedWeight);
        existing.weight = requestedWeight;
      }
      return;
    }
    const slotId = this.manager.addKeyedSlot(
      key,
      intent.source,
      kind,
      expressionName,
      requestedWeight,
    );
    this.slotsByKey.set(key, { slotId, weight: requestedWeight, seen: true });
  }
}

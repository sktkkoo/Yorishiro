/**
 * AttentionCueLight の "yielding default" 用 claim カウンタ。
 *
 * scene が自前の `<AttentionCueLight />` を mount している間、runtime 側の
 * `DefaultAttentionCueLight` は同じ光を二重に描画しないよう黙って退く。この
 * registry はその判定のための単純な参照カウンタで、kind 分岐は持たない
 * （attention cue light は単一種のため ui-claim-state のような kind 別 map は不要）。
 *
 * 注意: `DefaultAttentionCueLight` 自身はこの claim を取得しない。もし取得すると
 * 「default を描画 → 自分自身の claim で count>0 を検出 → 退く → claim が減り
 * count===0 に戻る → 再描画 → …」という無限ループになる。claim を取るのは
 * scene 側の `AttentionCueLight`（と `useClaimAttentionCue` 単体使用）だけ。
 */

import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";

type Listener = () => void;

export class AttentionCueClaimRegistry {
  private count = 0;
  private readonly listeners = new Set<Listener>();

  getCount(): number {
    return this.count;
  }

  /** claim する。戻り値の関数を呼ぶと release（多重呼び出しは 2 回目以降 no-op）。 */
  claim(): () => void {
    this.count += 1;
    this.notify();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.count -= 1;
      this.notify();
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function getAttentionCueClaimRegistry(): AttentionCueClaimRegistry {
  return getOrInit(KEYS.ATTENTION_CUE_CLAIMS, () => new AttentionCueClaimRegistry());
}

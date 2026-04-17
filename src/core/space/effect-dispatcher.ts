/**
 * EffectDispatcher — SpaceAPI.injectEffect を DOM-level subscribers に中継する
 * 薄い pub/sub。persona handler は `ctx.space.injectEffect(request)` を呼ぶだけで、
 * どの element にどう描画するかは subscriber 側の責務。
 *
 * Philosophy: docs/philosophy/PRESENCE_HARNESS.md「六要素 > 空間」
 * SDK surface: src/sdk/context.d.ts の SpaceAPI.injectEffect（407–412）
 *
 * 実装は kind 別の listener set。subscriber 追加は `subscribe(kind, listener)` で、
 * 返り値の unsubscribe 関数を呼べば外れる。
 */

import type { SpaceEffectHandle, SpaceEffectRequest } from "@charminal/sdk";

export type EffectListener = (request: SpaceEffectRequest) => void;

export class EffectDispatcher {
  private readonly listeners = new Map<string, Set<EffectListener>>();

  dispatch(request: SpaceEffectRequest): SpaceEffectHandle {
    const set = this.listeners.get(request.kind);
    if (set) {
      for (const listener of set) listener(request);
    }
    return {
      kind: request.kind,
      startedAt: 0,
      completion: Promise.resolve(),
      cancel: () => {},
    };
  }

  subscribe(kind: string, listener: EffectListener): () => void {
    let set = this.listeners.get(kind);
    if (!set) {
      set = new Set();
      this.listeners.set(kind, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }
}

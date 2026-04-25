import {
  type AttentionSnapshot,
  type AttentionTarget,
  resolveAttentionTarget,
} from "../../core/attention";
import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import type { AttentionRuntime } from "./types";

class AttentionRuntimeImpl implements AttentionRuntime {
  private readonly sources = new Map<string, AttentionTarget>();
  private readonly listeners = new Set<(snapshot: AttentionSnapshot) => void>();
  private snapshot: AttentionSnapshot = { target: null };

  setSourceTarget(source: string, target: AttentionTarget | null): void {
    if (target === null) {
      this.sources.delete(source);
    } else {
      this.sources.set(source, target);
    }
    this.publish();
  }

  get(): AttentionSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: AttentionSnapshot) => void) {
    this.listeners.add(listener);
    listener(this.snapshot);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  private publish(): void {
    const now = performance.now();
    const target = resolveAttentionTarget(Array.from(this.sources.values()), { now });
    const next: AttentionSnapshot = { target };
    if (sameSnapshot(this.snapshot, next)) return;
    this.snapshot = next;
    for (const listener of Array.from(this.listeners)) {
      listener(next);
    }
  }
}

/**
 * 同一 snapshot で listener を叩かないための等価判定。
 *
 * 全 field を比較する (timestamp 含む)。timestamp が違えば「同じ rect / kind /
 * source の新しい観察」として再 publish する — producer が一定間隔で同 rect を
 * 出してくる場合でも freshness 維持のため必要。
 */
function sameSnapshot(a: AttentionSnapshot, b: AttentionSnapshot): boolean {
  if (a.target === b.target) return true;
  if (a.target === null || b.target === null) return false;
  return (
    a.target.kind === b.target.kind &&
    a.target.source === b.target.source &&
    a.target.rect.x === b.target.rect.x &&
    a.target.rect.y === b.target.rect.y &&
    a.target.rect.width === b.target.rect.width &&
    a.target.rect.height === b.target.rect.height &&
    a.target.confidence === b.target.confidence &&
    a.target.priority === b.target.priority &&
    a.target.timestamp === b.target.timestamp &&
    a.target.reason === b.target.reason
  );
}

export function createAttentionRuntime(): AttentionRuntime {
  return new AttentionRuntimeImpl();
}

export function getAttentionRuntime(): AttentionRuntime {
  return getOrInit(KEYS.ATTENTION_RUNTIME, () => createAttentionRuntime());
}

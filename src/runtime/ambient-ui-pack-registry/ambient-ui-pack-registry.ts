/**
 * AmbientUiPackRegistry の multi-active impl。
 *
 * SingleActiveRegistry を流用しないのは active 集合が 0..n の semantic だから。
 * 同 id の origin 違い (bundled / user) は user-over-bundled で override する点
 * のみ単一 active と共通。
 *
 * Hot reload safety:
 * - register は同 id を replace。既存の active 集合は維持
 * - dispose handle で removeEntry + active 集合からも除去
 * - subscribeActiveSet は immediate-fire（subscribe 順序によらず最新値が届く）
 *
 * Internal design-record: 2026-04-25-attention-aura-v2-design.md
 */

import type { AmbientUiPackEntry, AmbientUiPackRegistry } from "./types";

interface InternalSubscriber {
  readonly listener: (ids: ReadonlyArray<string>) => void;
}

export class AmbientUiPackRegistryImpl implements AmbientUiPackRegistry {
  private readonly entries = new Map<string, AmbientUiPackEntry>();
  private readonly activeSet = new Set<string>();
  private readonly subscribers = new Set<InternalSubscriber>();

  register(entry: AmbientUiPackEntry) {
    this.entries.set(entry.id, entry);
    return {
      dispose: () => {
        this.entries.delete(entry.id);
        if (this.activeSet.delete(entry.id)) {
          this.publish();
        }
      },
    };
  }

  listEntries(): ReadonlyArray<AmbientUiPackEntry> {
    return Array.from(this.entries.values());
  }

  enable(id: string): void {
    if (!this.entries.has(id)) {
      console.warn(`[AmbientUiPackRegistry] enable: unknown id '${id}', ignoring`);
      return;
    }
    if (this.activeSet.has(id)) return;
    this.activeSet.add(id);
    this.publish();
  }

  disable(id: string): void {
    if (!this.activeSet.delete(id)) return;
    this.publish();
  }

  getActiveSet(): ReadonlyArray<string> {
    return Array.from(this.activeSet);
  }

  subscribeActiveSet(listener: (ids: ReadonlyArray<string>) => void) {
    const sub: InternalSubscriber = { listener };
    this.subscribers.add(sub);
    listener(this.getActiveSet());
    return {
      dispose: () => {
        this.subscribers.delete(sub);
      },
    };
  }

  private publish(): void {
    const ids = this.getActiveSet();
    for (const sub of Array.from(this.subscribers)) {
      sub.listener(ids);
    }
  }
}

export function createAmbientUiPackRegistry(): AmbientUiPackRegistry {
  return new AmbientUiPackRegistryImpl();
}

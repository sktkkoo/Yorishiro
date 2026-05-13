/**
 * AmenityPackRegistry の multi-active impl。
 *
 * ambient-ui と同じ multi-active semantic だが、amenity は activate() で
 * AmenityHandle を返す lifecycle を持つ点が異なる。handle.dispose() は
 * disable 時および旧 entry が override される時に呼ばれる。
 */

import type { AmenityPackEntry, AmenityPackRegistry } from "./types";

interface InternalSubscriber {
  readonly listener: (ids: ReadonlyArray<string>) => void;
}

export class AmenityPackRegistryImpl implements AmenityPackRegistry {
  private readonly entries = new Map<string, AmenityPackEntry>();
  private readonly activeSet = new Set<string>();
  private readonly subscribers = new Set<InternalSubscriber>();

  register(entry: AmenityPackEntry) {
    const existing = this.entries.get(entry.id);
    if (existing && existing !== entry) {
      existing.handle.dispose();
    }
    this.entries.set(entry.id, entry);
    return {
      dispose: () => {
        const current = this.entries.get(entry.id);
        if (current !== entry) return;
        this.entries.delete(entry.id);
        entry.handle.dispose();
        if (this.activeSet.delete(entry.id)) {
          this.publish();
        }
      },
    };
  }

  listEntries(): ReadonlyArray<AmenityPackEntry> {
    return Array.from(this.entries.values());
  }

  enable(id: string): void {
    if (!this.entries.has(id)) {
      console.warn(`[AmenityPackRegistry] enable: unknown id '${id}', ignoring`);
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

  getActiveHandle(id: string) {
    if (!this.activeSet.has(id)) return null;
    return this.entries.get(id)?.handle ?? null;
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

import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import type { VrmCache } from "./types";

/**
 * LRU cache of URL → raw VRM bytes. JavaScript の Map は insertion order を
 * 保つので、delete + set で「末尾に寄せる」操作が LRU の touch になる。
 *
 * Raw bytes を保持する理由は internal design-record:
 * 2026-04-17-phase-2.5-vrm-blob-cache.md 冒頭参照（parsed VRM の mutable state
 * 回避）。
 */
class VrmCacheImpl implements VrmCache {
  private readonly store = new Map<string, ArrayBuffer>();
  private readonly inFlight = new Map<string, Promise<ArrayBuffer>>();
  private maxEntries = 3;

  async getBytes(url: string): Promise<ArrayBuffer> {
    const key = this.normalize(url);

    // Cache hit: touch (delete + set で末尾へ移動) して返す
    const cached = this.store.get(key);
    if (cached !== undefined) {
      this.store.delete(key);
      this.store.set(key, cached);
      return cached;
    }

    // In-flight dedup: 同 URL への並行 fetch を 1 本にまとめる
    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending;

    const promise = (async () => {
      try {
        const response = await fetch(key);
        if (!response.ok) {
          throw new Error(`[vrm-cache] fetch ${key}: HTTP ${response.status}`);
        }
        const buffer = await response.arrayBuffer();
        this.store.set(key, buffer);
        this.evictOverflow();
        return buffer;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, promise);
    return promise;
  }

  setMaxEntries(n: number): void {
    if (n < 1) {
      throw new Error("[vrm-cache] maxEntries must be >= 1");
    }
    this.maxEntries = n;
    this.evictOverflow();
  }

  clear(): void {
    this.store.clear();
    // in-flight は放置（完了時に inFlight 側で削除される）
  }

  private normalize(url: string): string {
    try {
      return new URL(url, window.location.origin).href;
    } catch {
      return url;
    }
  }

  private evictOverflow(): void {
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
    }
  }
}

export function getVrmCache(): VrmCache {
  return getOrInit(KEYS.VRM_CACHE, () => new VrmCacheImpl());
}

if (import.meta.hot) {
  import.meta.hot.accept();
}

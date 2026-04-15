/**
 * Vite HMR hot.data wrapper. Returns a singleton instance across module reloads
 * during dev. In production (no import.meta.hot), falls back to a module-level
 * Map — semantics match HMR as long as this wrapper module itself is not reloaded.
 *
 * Philosophy: docs/design-record/specs/2026-04-15-hot-reload-and-ugc-hot-swap.md
 * section 5.1 (Phase 0a).
 */

type HotData = Record<string, unknown>;

interface HotContext {
  data: HotData;
}

const fallbackStore = new Map<string, unknown>();

const resolveHot = (): HotContext | null => {
  const meta = import.meta as ImportMeta & { hot?: HotContext };
  return meta.hot ?? null;
};

/**
 * Get an existing instance associated with `key`, or create one via `factory`
 * and store it for subsequent calls. Across HMR module reloads the same instance
 * is returned (when Vite HMR is active).
 */
export function getOrInit<T>(key: string, factory: () => T): T {
  const hot = resolveHot();
  if (hot) {
    const existing = hot.data[key];
    if (existing !== undefined) {
      return existing as T;
    }
    const created = factory();
    hot.data[key] = created;
    return created;
  }

  const existing = fallbackStore.get(key);
  if (existing !== undefined) {
    return existing as T;
  }
  const created = factory();
  fallbackStore.set(key, created);
  return created;
}

/**
 * Test-only helper. Clears both stores so tests start from a clean state.
 * Not exported from the barrel; tests import it directly from `./hot-data`.
 */
export function _clearForTest(): void {
  fallbackStore.clear();
  const hot = resolveHot();
  if (hot) {
    for (const key of Object.keys(hot.data)) {
      delete hot.data[key];
    }
  }
}

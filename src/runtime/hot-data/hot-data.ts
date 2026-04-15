/**
 * Vite HMR hot.data wrapper. Returns a singleton instance across module reloads
 * during dev. In production (no import.meta.hot), falls back to a module-level
 * Map — semantics match HMR as long as this wrapper module itself is not reloaded.
 *
 * Philosophy: docs/design-record/specs/2026-04-15-hot-reload-and-ugc-hot-swap.md
 * section 5.1 (Phase 0a).
 */

const fallbackStore = new Map<string, unknown>();

const resolveHotData = (): Record<string, unknown> | null => {
  return (import.meta.hot?.data as Record<string, unknown> | undefined) ?? null;
};

/**
 * Get an existing instance associated with `key`, or create one via `factory`
 * and store it for subsequent calls. Across HMR module reloads the same instance
 * is returned (when Vite HMR is active).
 *
 * @remarks The factory must not return `undefined`. `undefined` is used as the
 * sentinel for "not yet initialized"; a factory returning it will be re-invoked
 * on every call. Return `null` instead if you need an absence value.
 */
export function getOrInit<T>(key: string, factory: () => T): T {
  const hotData = resolveHotData();
  if (hotData) {
    const existing = hotData[key];
    if (existing !== undefined) {
      return existing as T;
    }
    const created = factory();
    hotData[key] = created;
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
  const hotData = resolveHotData();
  if (hotData) {
    // import.meta.hot.data is readonly per Vite's type, so clear by deleting keys.
    for (const key of Object.keys(hotData)) {
      delete hotData[key];
    }
  }
}

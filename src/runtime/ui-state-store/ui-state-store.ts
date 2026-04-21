import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import type { UiStateStore } from "./types";

class UiStateStoreImpl implements UiStateStore {
  private readonly values = new Map<string, Map<string, unknown>>();
  private readonly listeners = new Map<string, Map<string, Set<(value: unknown) => void>>>();

  get(packId: string, key: string): unknown {
    return this.values.get(packId)?.get(key);
  }

  set(packId: string, key: string, value: unknown): void {
    const values = this.valuesFor(packId);
    const previous = values.get(key);
    if (Object.is(previous, value)) return;

    values.set(key, value);
    const listeners = this.listeners.get(packId)?.get(key);
    if (!listeners) return;
    for (const listener of Array.from(listeners)) {
      listener(value);
    }
  }

  subscribe(packId: string, key: string, listener: (value: unknown) => void) {
    const packListeners = this.listenersFor(packId);
    let listeners = packListeners.get(key);
    if (!listeners) {
      listeners = new Set();
      packListeners.set(key, listeners);
    }
    listeners.add(listener);
    listener(this.get(packId, key));

    return {
      dispose: () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          packListeners.delete(key);
          if (packListeners.size === 0) {
            this.listeners.delete(packId);
          }
        }
      },
    };
  }

  entries(packId: string): Record<string, unknown> {
    return Object.fromEntries(this.values.get(packId) ?? []);
  }

  private valuesFor(packId: string): Map<string, unknown> {
    let values = this.values.get(packId);
    if (!values) {
      values = new Map();
      this.values.set(packId, values);
    }
    return values;
  }

  private listenersFor(packId: string): Map<string, Set<(value: unknown) => void>> {
    let listeners = this.listeners.get(packId);
    if (!listeners) {
      listeners = new Map();
      this.listeners.set(packId, listeners);
    }
    return listeners;
  }
}

export function createUiStateStore(): UiStateStore {
  return new UiStateStoreImpl();
}

/** hot-data singleton。HMR をまたいで UI state を保持する。 */
export function getUiStateStore(): UiStateStore {
  return getOrInit(KEYS.UI_STATE_STORE, () => createUiStateStore());
}

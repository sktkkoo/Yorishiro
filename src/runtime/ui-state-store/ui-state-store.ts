import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import type { UiStateStore } from "./types";

class UiStateStoreImpl implements UiStateStore {
  private readonly values = new Map<string, unknown>();
  private readonly listeners = new Map<string, Set<(value: unknown) => void>>();

  get(key: string): unknown {
    return this.values.get(key);
  }

  set(key: string, value: unknown): void {
    const previous = this.values.get(key);
    if (Object.is(previous, value)) return;

    this.values.set(key, value);
    const listeners = this.listeners.get(key);
    if (!listeners) return;
    for (const listener of Array.from(listeners)) {
      listener(value);
    }
  }

  subscribe(key: string, listener: (value: unknown) => void) {
    let listeners = this.listeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(key, listeners);
    }
    listeners.add(listener);
    listener(this.get(key));

    return {
      dispose: () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          this.listeners.delete(key);
        }
      },
    };
  }

  entries(): Record<string, unknown> {
    return Object.fromEntries(this.values);
  }
}

export function createUiStateStore(): UiStateStore {
  return new UiStateStoreImpl();
}

/** hot-data singleton。HMR をまたいで UI state を保持する。 */
export function getUiStateStore(): UiStateStore {
  return getOrInit(KEYS.UI_STATE_STORE, () => createUiStateStore());
}

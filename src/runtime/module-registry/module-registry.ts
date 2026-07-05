import type { Trigger } from "@yorishiro/sdk";
import { getOrInit } from "../hot-data";
import { KEYS } from "./keys";
import { type AllowedKindFor, isAllowed, type ModuleKind, type Provenance } from "./provenance";

/**
 * The instance type expected for each kind. Phase 1 reuses the SDK Trigger
 * shape for trigger-handler so EventBus consumers can hand the same object
 * to ModuleRegistry.register without widening or casts. procedural-module
 * and animation-provider are stubs — concrete interfaces land in Phase 3.
 */
export interface ModuleOf {
  "trigger-handler": Trigger;
  "procedural-module": { readonly id: string };
  "animation-provider": { readonly id: string };
}

export interface RegistryEntry<K extends ModuleKind> {
  readonly id: string;
  readonly provenance: Provenance;
  readonly instance: ModuleOf[K];
}

export interface Disposable {
  dispose(): void;
}

type KindStore = {
  [K in ModuleKind]: Map<string, RegistryEntry<K>>;
};

const emptyStore = (): KindStore => ({
  "trigger-handler": new Map(),
  "procedural-module": new Map(),
  "animation-provider": new Map(),
});

export class ModuleRegistry {
  private readonly store: KindStore = emptyStore();

  /**
   * Register an entry under the given kind. The Provenance source must be
   * allowed for that kind (enforced both at the type level via the K extends
   * AllowedKindFor<...> bound and at runtime via isAllowed).
   *
   * @returns a Disposable; calling dispose() removes the entry.
   * @throws if a duplicate id is already registered for the same kind.
   */
  register<K extends ModuleKind, S extends Provenance["source"]>(
    kind: K & AllowedKindFor<S>,
    entry: { id: string; provenance: Provenance & { source: S }; instance: ModuleOf[K] },
  ): Disposable {
    if (!isAllowed(kind, entry.provenance)) {
      throw new Error(
        `[ModuleRegistry] Provenance ${entry.provenance.source} cannot register kind ${kind}`,
      );
    }
    const map = this.store[kind] as Map<string, RegistryEntry<K>>;
    if (map.has(entry.id)) {
      throw new Error(`[ModuleRegistry] duplicate id "${entry.id}" for kind "${kind}"`);
    }
    map.set(entry.id, entry as RegistryEntry<K>);
    return {
      dispose: () => {
        map.delete(entry.id);
      },
    };
  }

  /**
   * Replace the instance of an existing entry. Used by HMR accept callbacks
   * and by UGC swaps. The entry's id and provenance are preserved.
   *
   * @throws if no entry with the given id is registered for the kind.
   */
  swap<K extends ModuleKind>(kind: K, id: string, next: ModuleOf[K]): void {
    const map = this.store[kind] as Map<string, RegistryEntry<K>>;
    const existing = map.get(id);
    if (!existing) {
      throw new Error(`[ModuleRegistry] no entry to swap for kind "${kind}" id "${id}"`);
    }
    map.set(id, { ...existing, instance: next });
  }

  list<K extends ModuleKind>(kind: K): readonly RegistryEntry<K>[] {
    const map = this.store[kind] as Map<string, RegistryEntry<K>>;
    return Array.from(map.values());
  }

  get<K extends ModuleKind>(kind: K, id: string): ModuleOf[K] | undefined {
    const map = this.store[kind] as Map<string, RegistryEntry<K>>;
    return map.get(id)?.instance;
  }
}

/**
 * The HMR-surviving singleton accessor. Always prefer this over
 * `new ModuleRegistry()` in app code; constructing your own instance is for
 * tests only.
 */
export function getModuleRegistry(): ModuleRegistry {
  return getOrInit(KEYS.MODULE_REGISTRY, () => new ModuleRegistry());
}

if (import.meta.hot) {
  import.meta.hot.accept();
}

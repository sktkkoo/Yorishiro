import type { useCreateStore } from "leva";
import { useSyncExternalStore } from "react";

export type RuntimeLevaStore = ReturnType<typeof useCreateStore>;

type Listener = () => void;

let runtimeStore: RuntimeLevaStore | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of Array.from(listeners)) listener();
}

export function setRuntimeLevaStore(next: RuntimeLevaStore | null): void {
  runtimeStore = next;
  emit();
}

export function getRuntimeLevaStore(): RuntimeLevaStore | null {
  return runtimeStore;
}

export function subscribeRuntimeLevaStore(listener: Listener): { dispose: () => void } {
  listeners.add(listener);
  return {
    dispose: () => {
      listeners.delete(listener);
    },
  };
}

export function useRuntimeLevaStore(): RuntimeLevaStore | null {
  return useSyncExternalStore(
    (listener) => {
      const subscription = subscribeRuntimeLevaStore(listener);
      return () => subscription.dispose();
    },
    getRuntimeLevaStore,
    getRuntimeLevaStore,
  );
}

import { useSyncExternalStore } from "react";
import type { LevaStore } from "../leva";

type Listener = () => void;

let activeSceneStore: LevaStore | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of Array.from(listeners)) listener();
}

export function setActiveSceneLevaStore(next: LevaStore | null): void {
  activeSceneStore = next;
  emit();
}

export function clearActiveSceneLevaStore(store: LevaStore): void {
  if (activeSceneStore !== store) return;
  activeSceneStore = null;
  emit();
}

export function getActiveSceneLevaStore(): LevaStore | null {
  return activeSceneStore;
}

export function subscribeActiveSceneLevaStore(listener: Listener): { dispose: () => void } {
  listeners.add(listener);
  return {
    dispose: () => {
      listeners.delete(listener);
    },
  };
}

export function useActiveSceneLevaStore(): LevaStore | null {
  return useSyncExternalStore(
    (listener) => {
      const subscription = subscribeActiveSceneLevaStore(listener);
      return () => subscription.dispose();
    },
    getActiveSceneLevaStore,
    getActiveSceneLevaStore,
  );
}

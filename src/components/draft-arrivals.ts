import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import type { ContinuityDraft } from "../runtime/continuity/types";
import { continuityComposerIdentity } from "./continuity-composer";

export interface DraftArrival {
  readonly id: string;
  readonly content: string;
  readonly title: string;
  readonly kind: "new" | "updated";
}

export function createDraftArrivalStore() {
  const personas = new Map<string, ReturnType<typeof createEntry>>();
  return {
    forPersona(personaId: string) {
      const key = continuityComposerIdentity(personaId);
      let entry = personas.get(key);
      if (!entry) {
        entry = createEntry();
        personas.set(key, entry);
      }
      return entry;
    },
  };
}

function createEntry() {
  let baseline: Map<string, string> | null = null;
  let pending: readonly DraftArrival[] = [];
  const listeners = new Set<() => void>();
  function publish(next: readonly DraftArrival[]) {
    if (
      next.length === pending.length &&
      next.every((item, index) => {
        const previous = pending[index];
        return (
          item.id === previous.id &&
          item.content === previous.content &&
          item.title === previous.title &&
          item.kind === previous.kind
        );
      })
    )
      return;
    pending = next;
    for (const listener of listeners) listener();
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => pending,
    observe(drafts: readonly ContinuityDraft[] | null) {
      if (!drafts) return;
      const ready = new Map(
        drafts.filter((item) => item.status === "ready").map((item) => [item.id, item]),
      );
      if (baseline) {
        const next = new Map(
          pending.filter((item) => ready.has(item.id)).map((item) => [item.id, item]),
        );
        for (const draft of ready.values()) {
          const previous = next.get(draft.id);
          // ネイティブの進捗判定と同じく、本文以外の変更だけでは再通知しない。
          if (previous || baseline.get(draft.id) !== draft.content) {
            next.set(draft.id, {
              id: draft.id,
              content: draft.content,
              title: draft.title,
              kind: previous?.kind ?? (baseline.has(draft.id) ? "updated" : "new"),
            });
          }
        }
        publish([...next.values()]);
      }
      baseline = new Map([...ready.values()].map((item) => [item.id, item.content]));
    },
    acknowledge(id: string, content: string) {
      // 開いた本文だけを確認済みにし、その後に届いた更新は残す。
      publish(pending.filter((item) => item.id !== id || item.content !== content));
    },
  };
}

// 住人を切り替えても未確認の草案を保ち、アプリの再読込時は履歴を基準にし直す。
const sessionArrivals = createDraftArrivalStore();
export function useDraftArrivals(
  personaId: string,
  drafts: readonly ContinuityDraft[] | null,
  store = sessionArrivals,
) {
  const entry = useMemo(() => store.forPersona(personaId), [personaId, store]);
  const pending = useSyncExternalStore(entry.subscribe, entry.getSnapshot);
  useLayoutEffect(() => entry.observe(drafts), [entry, drafts]);
  return { pending: drafts === null ? [] : pending, acknowledge: entry.acknowledge };
}

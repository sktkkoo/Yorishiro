import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import type {
  AutonomyContract,
  AutonomyDraft,
  AutonomyStatus,
  SetupMessage,
  SetupReply,
} from "./types";

let snapshot: AutonomyStatus | null = null;
let draftSnapshot: AutonomyDraft | null = null;
let announcedReviewId: string | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let polling: Promise<void> | null = null;

async function readStatus(): Promise<void> {
  try {
    // The backend owns claiming, budgets and execution. Multiple views/timers
    // cannot start the same run. A tick does not create or broaden a contract.
    let tickError: string | null = null;
    try {
      await invoke("autonomy_tick");
    } catch (error) {
      tickError = String(error);
    }
    snapshot = await invoke<AutonomyStatus>("autonomy_status");
    draftSnapshot = (await invoke<AutonomyDraft | null>("autonomy_draft_get")) ?? null;
    if (tickError) snapshot = { ...snapshot, error: tickError };
    const review = snapshot.pendingWork;
    if (review && review.id !== announcedReviewId && typeof window !== "undefined") {
      announcedReviewId = review.id;
      window.dispatchEvent(
        new CustomEvent("yorishiro:autonomy-work-review-available", { detail: review }),
      );
    }
    for (const notify of listeners) notify();
  } catch (error) {
    snapshot = {
      ...(snapshot ?? { contract: null, phase: "failed", nextRunAt: null, runs: [] }),
      error: String(error),
    };
    for (const notify of listeners) notify();
  } finally {
    polling = null;
    if (timer !== null) clearTimeout(timer);
    timer = listeners.size ? setTimeout(() => void poll(), 15_000) : null;
  }
}

function poll(): Promise<void> {
  if (polling !== null) return polling;
  polling = readStatus();
  return polling;
}

async function refreshAfterAction(): Promise<void> {
  // A status read that started before the action may still contain its old
  // state. Await it, then read again; never leave the switch stale for a tick.
  if (polling !== null) await polling;
  await poll();
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
    if (!listeners.size && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

export function useAutonomyStatus(): AutonomyStatus | null {
  const value = useSyncExternalStore(subscribe, () => snapshot);
  useEffect(() => {
    void poll();
  }, []);
  return value;
}

export function useAutonomyDraft(): AutonomyDraft | null {
  const value = useSyncExternalStore(subscribe, () => draftSnapshot);
  useEffect(() => {
    void poll();
  }, []);
  return value;
}

export const consultAutonomy = (history: readonly SetupMessage[]): Promise<SetupReply> =>
  invoke("autonomy_consult", { history });

export async function saveAutonomyContract(contract: AutonomyContract): Promise<void> {
  const reviewedId = draftSnapshot?.id;
  await invoke("autonomy_save", { contract });
  if (reviewedId) {
    // Acknowledge only the reviewed draft; a newer voice proposal must survive.
    await invoke("autonomy_draft_dismiss", { id: reviewedId });
  }
  await refreshAfterAction();
}

export async function approvePendingWork(id: string): Promise<void> {
  await invoke("autonomy_review", { id, approved: true });
  await refreshAfterAction();
}

export async function declinePendingWork(id: string): Promise<void> {
  await invoke("autonomy_review", { id, approved: false });
  await refreshAfterAction();
}

export async function setAutonomyEnabled(enabled: boolean): Promise<void> {
  await invoke("autonomy_set_enabled", { enabled });
  await refreshAfterAction();
}

export async function pauseAutonomy(): Promise<void> {
  await invoke("autonomy_pause");
  await refreshAfterAction();
}

export async function runAutonomyNow(): Promise<void> {
  await invoke("autonomy_run_now");
  await refreshAfterAction();
}

export async function undoAutonomyRun(runId: string): Promise<void> {
  await invoke("autonomy_undo", { runId });
  await refreshAfterAction();
}

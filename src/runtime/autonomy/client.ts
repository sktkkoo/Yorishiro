import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useSyncExternalStore } from "react";
import type {
  AutonomyConfirmationNotice,
  AutonomyContract,
  AutonomyDraft,
  AutonomyDraftPatch,
  AutonomyDraftSnapshot,
  AutonomyStatus,
  DraftEditResult,
  SetupMessage,
  SetupReply,
} from "./types";

let snapshot: AutonomyStatus | null = null;
let draftSnapshot: AutonomyDraftSnapshot = { revision: -1, draft: null };
let announcedReviewId: string | null = null;
let announcedConfirmationKey: string | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let polling: Promise<void> | null = null;
let draftUnlisten: UnlistenFn | null = null;
let draftListenerEpoch = 0;
let draftRetryTimer: ReturnType<typeof setTimeout> | null = null;
let draftSyncError: string | null = null;

function acceptDraft(next: AutonomyDraftSnapshot): void {
  // An older poll or IPC response can finish after a live event. Never roll
  // the visible shared form back, including a stale dismissal event.
  if (!Number.isSafeInteger(next?.revision) || next.revision <= draftSnapshot.revision) return;
  draftSnapshot = next;
  for (const notify of listeners) notify();
}

async function refreshDraft(): Promise<void> {
  acceptDraft(await invoke<AutonomyDraftSnapshot>("autonomy_draft_snapshot"));
}

function startDraftEvents(): void {
  if (draftRetryTimer !== null) clearTimeout(draftRetryTimer);
  draftRetryTimer = null;
  const epoch = ++draftListenerEpoch;
  void listen<AutonomyDraftSnapshot>("autonomy:draft-changed", (event) => {
    if (epoch === draftListenerEpoch) acceptDraft(event.payload);
  })
    .then(async (unlisten) => {
      if (epoch !== draftListenerEpoch || !listeners.size) {
        unlisten();
        return;
      }
      draftUnlisten = unlisten;
      // Subscribe before fetching to close the gap between initial read and
      // listener registration. Polling remains a recovery path for missed events.
      await refreshDraft();
      if (epoch !== draftListenerEpoch) return;
      if (draftSyncError && snapshot?.error === draftSyncError) {
        snapshot = { ...snapshot, error: null };
        for (const notify of listeners) notify();
      }
      draftSyncError = null;
    })
    .catch((error: unknown) => {
      if (epoch !== draftListenerEpoch) return;
      draftUnlisten?.();
      draftUnlisten = null;
      draftSyncError = `設定案のリアルタイム同期を開始できません。再接続しています: ${String(error)}`;
      if (snapshot) {
        snapshot = { ...snapshot, error: draftSyncError };
        for (const notify of listeners) notify();
      }
      draftRetryTimer = setTimeout(() => {
        draftRetryTimer = null;
        if (epoch === draftListenerEpoch && listeners.size) startDraftEvents();
      }, 5_000);
    });
}

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
    const review = snapshot.pendingWork;
    if ((review?.id ?? null) !== announcedReviewId && typeof window !== "undefined") {
      announcedReviewId = review?.id ?? null;
      window.dispatchEvent(
        new CustomEvent("yorishiro:autonomy-work-review-available", { detail: review ?? null }),
      );
    }
    const confirmation = snapshot.pendingActions?.find((action) => action.status === "pending");
    const confirmationKey = confirmation ? `${confirmation.id}:${confirmation.status}` : null;
    if (confirmationKey !== announcedConfirmationKey && typeof window !== "undefined") {
      announcedConfirmationKey = confirmationKey;
      const detail: AutonomyConfirmationNotice | null = confirmation
        ? {
            id: confirmation.id,
            runId: confirmation.runId,
            kind: confirmation.kind,
            summary: confirmation.summary,
            status: confirmation.status,
          }
        : null;
      window.dispatchEvent(
        new CustomEvent("yorishiro:autonomy-confirmation-available", { detail }),
      );
    }
    // Clearing a reviewed card must not wait for the independent setup-draft
    // channel; otherwise a draft sync failure could leave a stale voice prompt.
    await refreshDraft();
    if (tickError || draftSyncError) snapshot = { ...snapshot, error: tickError ?? draftSyncError };
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
    timer = listeners.size
      ? setTimeout(() => void poll(), snapshot?.phase === "stopping" ? 1_000 : 15_000)
      : null;
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
  const first = listeners.size === 0;
  listeners.add(notify);
  if (first) startDraftEvents();
  return () => {
    listeners.delete(notify);
    if (!listeners.size && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!listeners.size) {
      ++draftListenerEpoch;
      if (draftRetryTimer !== null) clearTimeout(draftRetryTimer);
      draftRetryTimer = null;
      draftUnlisten?.();
      draftUnlisten = null;
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
  return useAutonomyDraftSnapshot().draft;
}

export function useAutonomyDraftSnapshot(): AutonomyDraftSnapshot {
  const value = useSyncExternalStore(subscribe, () => draftSnapshot);
  useEffect(() => {
    void poll();
  }, []);
  return value;
}

export async function editAutonomyDraft(
  baseId: string | null,
  patch: AutonomyDraftPatch,
): Promise<DraftEditResult> {
  const result = await invoke<DraftEditResult>("autonomy_draft_edit", { baseId, patch });
  acceptDraft(result.snapshot);
  return result;
}

export async function consultAutonomy(history: readonly SetupMessage[]): Promise<SetupReply> {
  const result = await invoke<SetupReply>("autonomy_consult", { history });
  if (result.draftSnapshot) acceptDraft(result.draftSnapshot);
  return result;
}

export async function saveAutonomyContract(
  contract: AutonomyContract,
  reviewedDraftId: string | null = null,
): Promise<void> {
  await invoke("autonomy_save", { contract });
  if (reviewedDraftId) {
    // Acknowledge only the reviewed draft; a newer voice proposal must survive.
    await invoke("autonomy_draft_dismiss", { id: reviewedDraftId });
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
  try {
    await invoke("autonomy_set_enabled", { enabled });
  } finally {
    await refreshAfterAction();
  }
}

export async function pauseAutonomy(): Promise<void> {
  try {
    await invoke("autonomy_pause");
  } finally {
    await refreshAfterAction();
  }
}

export async function runAutonomyNow(): Promise<void> {
  await invoke("autonomy_run_now");
  await refreshAfterAction();
}

export async function undoAutonomyRun(runId: string): Promise<void> {
  await invoke("autonomy_undo", { runId });
  await refreshAfterAction();
}

export async function prepareAutonomyAction(runId: string): Promise<void> {
  try {
    await invoke("autonomy_prepare_action", { runId });
  } finally {
    await refreshAfterAction();
  }
}

export async function approveAutonomyAction(id: string, digest: string): Promise<void> {
  try {
    await invoke("autonomy_approve_action", { id, digest });
  } finally {
    await refreshAfterAction();
  }
}

export async function declineAutonomyAction(id: string): Promise<void> {
  try {
    await invoke("autonomy_decline_action", { id });
  } finally {
    await refreshAfterAction();
  }
}

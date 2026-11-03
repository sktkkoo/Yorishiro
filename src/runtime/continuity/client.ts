import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useSyncExternalStore } from "react";
import type { ContinuityContext, ContinuitySnapshot } from "./types";

export function continuityIdentity(id: string): string {
  return id === "yori-ja" || id === "yori-en" ? "builtin:yori" : `custom:${id}`;
}
interface Entry {
  snapshot: ContinuitySnapshot | null;
  error: string | null;
  listeners: Set<() => void>;
  value: { snapshot: ContinuitySnapshot | null; error: string | null };
}
const entries = new Map<string, Entry>();
const empty = { snapshot: null, error: null };
let unlisten: UnlistenFn | null = null;
let bridge: Promise<void> | null = null;
function entry(key: string): Entry {
  let value = entries.get(key);
  if (!value) {
    value = { ...empty, listeners: new Set(), value: empty };
    entries.set(key, value);
  }
  return value;
}
function notify(value: Entry): void {
  value.value = { snapshot: value.snapshot, error: value.error };
  for (const listener of value.listeners) listener();
}
function accept(snapshot: ContinuitySnapshot): void {
  const value = entry(continuityIdentity(snapshot.personaId));
  if (value.snapshot && value.snapshot.revision > snapshot.revision) return;
  value.snapshot = snapshot;
  value.error = null;
  notify(value);
}
async function ensureBridge(): Promise<void> {
  if (unlisten) return;
  if (!bridge) {
    bridge = listen<ContinuitySnapshot>("continuity:changed", (event) => accept(event.payload))
      .then((dispose) => {
        unlisten = dispose;
      })
      .finally(() => {
        bridge = null;
      });
  }
  await bridge;
}
async function command(
  name: string,
  context: ContinuityContext,
  args: Record<string, unknown> = {},
): Promise<void> {
  try {
    accept(await invoke<ContinuitySnapshot>(name, { context, ...args }));
  } catch (error) {
    const value = entry(continuityIdentity(context.personaId));
    value.error = error instanceof Error ? error.message : String(error);
    notify(value);
    throw error;
  }
}
export function sendContinuityMessage(
  context: ContinuityContext,
  text: string,
  correctionId?: string,
): Promise<void> {
  return command("continuity_send", context, { text, correctionId: correctionId ?? null });
}
export function actOnContinuityDraft(
  context: ContinuityContext,
  draftId: string,
  action: "continue" | "dismiss",
): Promise<void> {
  return command("continuity_draft_action", context, { draftId, action });
}
export function observeContinuityExchange(
  context: ContinuityContext,
  exchange: {
    readonly userText: string;
    readonly assistantText: string;
    readonly sourceKey: string;
  },
): Promise<void> {
  return command("continuity_observe_native", context, exchange);
}
export function retryContinuity(context: ContinuityContext): Promise<void> {
  return ensureBridge().then(() => command("continuity_retry", context));
}
export function useContinuity(context: ContinuityContext | null, open: boolean): Entry["value"] {
  const id = context ? continuityIdentity(context.personaId) : null;
  const value = useSyncExternalStore(
    (listener) => {
      if (!id) return () => {};
      const current = entry(id);
      current.listeners.add(listener);
      return () => current.listeners.delete(listener);
    },
    () => (id ? entry(id).value : empty),
  );
  // Keep the host subscription alive across hidden/unmounted views. Native owns
  // the operation; detaching a React surface never cancels or restarts it.
  const personaId = context?.personaId;
  const personaName = context?.personaName;
  const personaPrompt = context?.personaPrompt;
  const language = context?.language;
  const cwd = context?.cwd;
  const executionSessionId = context?.executionSessionId;
  useEffect(() => {
    if (!personaId || !personaName || !language) return;
    const current: ContinuityContext = {
      personaId,
      personaName,
      personaPrompt: personaPrompt ?? "",
      language,
      cwd: cwd ?? null,
      ...(executionSessionId !== undefined ? { executionSessionId } : {}),
    };
    const target = entry(continuityIdentity(personaId));
    let cancelled = false;
    let requestInFlight = false;
    let entered = false;
    let attemptedAdvanceRevision: number | null = null;
    let timer: number | null = null;
    let timerKey: string | null = null;
    let quietDeadline: { key: string; at: number } | null = null;
    const canRefresh = () => !cancelled && document.visibilityState !== "hidden";
    const clearTimer = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      timerKey = null;
    };
    const scheduleNext = () => {
      if (!open || !canRefresh()) {
        clearTimer();
        quietDeadline = null;
        return;
      }
      if (requestInFlight) return;
      const snapshot = target.snapshot;
      if (
        snapshot?.phase === "thinking" ||
        snapshot?.phase === "drafting" ||
        snapshot?.phase === "working"
      ) {
        clearTimer();
        quietDeadline = null;
        return;
      }
      const revision =
        !target.error &&
        snapshot?.phase === "idle" &&
        snapshot.nextStep?.trim() &&
        snapshot.revision !== attemptedAdvanceRevision
          ? snapshot.revision
          : null;
      const key = `${revision === null ? "wait" : "advance"}:${snapshot?.revision ?? "unknown"}`;
      if (timer !== null && timerKey === key) return;
      clearTimer();
      timerKey = key;
      if (revision !== null) quietDeadline = null;
      else if (quietDeadline?.key !== key) {
        quietDeadline = { key, at: Date.now() + 5 * 60 * 1000 };
      }
      timer = window.setTimeout(
        () => {
          timer = null;
          timerKey = null;
          if (!canRefresh()) return;
          if (revision !== null) {
            attemptedAdvanceRevision = revision;
            void run("continuity_advance", { revision });
          } else {
            void run("continuity_tick");
          }
        },
        revision === null ? Math.max(0, (quietDeadline?.at ?? Date.now()) - Date.now()) : 0,
      );
    };
    const run = async (name: string, args: Record<string, unknown> = {}) => {
      if (!canRefresh() || requestInFlight) return;
      requestInFlight = true;
      clearTimer();
      // Focus sync may take time but must not postpone an existing quiet recheck.
      if (name !== "continuity_sync_context") quietDeadline = null;
      try {
        await ensureBridge();
        if (!canRefresh()) return;
        await command(name, current, args);
        if (name === "continuity_enter") entered = true;
      } catch (error: unknown) {
        if (cancelled) return;
        target.error = error instanceof Error ? error.message : String(error);
        notify(target);
      } finally {
        requestInFlight = false;
        scheduleNext();
      }
    };
    const refreshOnReturn = () => {
      if (!canRefresh()) {
        clearTimer();
        quietDeadline = null;
        return;
      }
      void run(open && !entered ? "continuity_enter" : "continuity_sync_context");
    };
    // A successful completion drives the next step immediately. A quiet result
    // or error gets a five-minute recheck; busy workers have no wake-up timer.
    target.listeners.add(scheduleNext);
    refreshOnReturn();
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      cancelled = true;
      clearTimer();
      target.listeners.delete(scheduleNext);
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [personaId, personaName, personaPrompt, language, cwd, executionSessionId, open]);
  return value;
}

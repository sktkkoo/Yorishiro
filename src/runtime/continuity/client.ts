import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useSyncExternalStore } from "react";
import type { ContinuityContext, ContinuitySnapshot } from "./types";

export function continuityIdentity(id: string): string {
  return id === "yori-ja" || id === "yori-en" ? "builtin:yori" : `custom:${id}`;
}
export type ContinuityErrorSource =
  | "send"
  | "draft"
  | "forget"
  | "autonomy"
  | "observation"
  | "sync"
  | "work";
interface ContinuityValue {
  snapshot: ContinuitySnapshot | null;
  error: string | null;
  errorSource: ContinuityErrorSource | null;
}
interface Entry extends ContinuityValue {
  listeners: Set<() => void>;
  value: ContinuityValue;
}
const entries = new Map<string, Entry>();
const observationTails = new Map<string, Promise<void>>();
const empty = { snapshot: null, error: null, errorSource: null };
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
  value.value = { snapshot: value.snapshot, error: value.error, errorSource: value.errorSource };
  for (const listener of value.listeners) listener();
}
function accept(snapshot: ContinuitySnapshot): void {
  const value = entry(continuityIdentity(snapshot.personaId));
  if (value.snapshot && value.snapshot.revision > snapshot.revision) return;
  const previousSequence = value.snapshot?.publicationSequence;
  const incomingSequence = snapshot.publicationSequence;
  // 同じ保存版の一時的な表示状態は公開順に受理し、遅れた応答で待機状態を戻さない。
  if (
    value.snapshot?.revision === snapshot.revision &&
    typeof previousSequence === "number" &&
    Number.isSafeInteger(previousSequence) &&
    previousSequence >= 0 &&
    typeof incomingSequence === "number" &&
    Number.isSafeInteger(incomingSequence) &&
    incomingSequence >= 0 &&
    incomingSequence < previousSequence
  )
    return;
  value.snapshot = snapshot;
  value.error = null;
  value.errorSource = null;
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
  errorSource: ContinuityErrorSource | null = "work",
  requireBridge = false,
): Promise<void> {
  try {
    if (requireBridge) await ensureBridge();
    accept(await invoke<ContinuitySnapshot>(name, { context, ...args }));
  } catch (error) {
    if (errorSource !== null) {
      const value = entry(continuityIdentity(context.personaId));
      value.error = error instanceof Error ? error.message : String(error);
      value.errorSource = errorSource;
      notify(value);
    }
    throw error;
  }
}
export function sendContinuityMessage(
  context: ContinuityContext,
  text: string,
  correctionId?: string,
): Promise<void> {
  return command("continuity_send", context, { text, correctionId: correctionId ?? null }, "send");
}
export function actOnContinuityDraft(
  context: ContinuityContext,
  draftId: string,
  action: "continue" | "dismiss",
): Promise<void> {
  return command("continuity_draft_action", context, { draftId, action }, "draft");
}
export function forgetContinuityUnderstanding(
  context: ContinuityContext,
  understandingId: string,
): Promise<void> {
  return command("continuity_forget_understanding", context, { understandingId }, "forget");
}
export function observeContinuityExchange(
  context: ContinuityContext,
  exchange: {
    readonly userText: string;
    readonly assistantText: string;
    readonly sourceKey: string;
  },
): Promise<void> {
  // 音声の transcript callback は await しない。native の非同期 command が
  // mutex を取る順序に依存せず、同じ保存先への発言を受信順で記録する。
  const key = continuityIdentity(context.personaId);
  const previous = observationTails.get(key);
  const run = () => command("continuity_observe_native", context, exchange, "observation");
  const result = previous ? previous.then(run) : run();
  const cleanup = () => {
    if (observationTails.get(key) === tail) observationTails.delete(key);
  };
  // 呼び出し元には失敗を返すが、後続の発言まで失敗させない。
  const tail = result.then(cleanup, cleanup);
  observationTails.set(key, tail);
  return result;
}
export function retryContinuity(context: ContinuityContext): Promise<void> {
  return command("continuity_retry", context, {}, "work", true);
}
export function refreshContinuity(context: ContinuityContext): Promise<void> {
  return command("continuity_sync_context", context, {}, "sync", true);
}
export function setContinuityAutoEnabled(
  context: ContinuityContext,
  enabled: boolean,
): Promise<void> {
  return command("continuity_set_auto_enabled", context, { enabled }, "autonomy", true);
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
  const executionBackend = context?.executionBackend;
  const executionSessionId = context?.executionSessionId;
  useEffect(() => {
    if (!personaId || !personaName || !language) return;
    const current: ContinuityContext = {
      personaId,
      personaName,
      personaPrompt: personaPrompt ?? "",
      language,
      cwd: cwd ?? null,
      ...(executionBackend !== undefined ? { executionBackend } : {}),
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
      if (snapshot?.autoEnabled !== true) {
        clearTimer();
        quietDeadline = null;
        return;
      }
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
        // 同期エラーはこのeffectが所有し、現在の文脈である間だけ公開する。
        // nativeのsnapshotは文脈の切替後もrevision順に受理する。
        await command(name, current, args, null);
        if (name === "continuity_enter") entered = true;
      } catch (error: unknown) {
        if (cancelled) return;
        target.error = error instanceof Error ? error.message : String(error);
        target.errorSource =
          name === "continuity_enter" || name === "continuity_sync_context" ? "sync" : "work";
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
  }, [
    personaId,
    personaName,
    personaPrompt,
    language,
    cwd,
    executionBackend,
    executionSessionId,
    open,
  ]);
  return value;
}

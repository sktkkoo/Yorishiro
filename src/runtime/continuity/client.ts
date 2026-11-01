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
  useEffect(() => {
    if (!personaId || !personaName || !language) return;
    const current: ContinuityContext = {
      personaId,
      personaName,
      personaPrompt: personaPrompt ?? "",
      language,
      cwd: cwd ?? null,
    };
    let cancelled = false;
    let requestInFlight = false;
    const canRefresh = () => !cancelled && document.visibilityState !== "hidden";
    const refresh = async (periodic = false) => {
      if (!canRefresh() || requestInFlight) return;
      requestInFlight = true;
      try {
        await ensureBridge();
        if (!canRefresh()) return;
        if (open) {
          await command(periodic ? "continuity_tick" : "continuity_enter", current);
        } else {
          await command("continuity_sync_context", current);
        }
      } catch (error: unknown) {
        if (cancelled) return;
        const target = entry(continuityIdentity(personaId));
        target.error = error instanceof Error ? error.message : String(error);
        notify(target);
      } finally {
        requestInFlight = false;
      }
    };
    void refresh();
    // Start a fresh interval when this screen opens. Closing it, changing the
    // persona/context or unmounting discards the timer and any unsent tick.
    // Focus changes refresh state but never trigger an extra periodic run.
    // Count the next period after native acknowledges this tick, so transport
    // latency cannot make a valid tick arrive just inside the native dedup gap.
    let timer: number | null = null;
    const schedule = () => {
      timer = window.setTimeout(
        () => {
          void refresh(true).finally(() => {
            if (!cancelled) schedule();
          });
        },
        30 * 60 * 1000,
      );
    };
    if (open) schedule();
    const refreshOnReturn = () => void refresh();
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [personaId, personaName, personaPrompt, language, cwd, open]);
  return value;
}

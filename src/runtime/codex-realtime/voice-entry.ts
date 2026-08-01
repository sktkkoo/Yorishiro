import type { AgentDescriptor } from "../../bindings/tauri-commands";

export const PENDING_REALTIME_START_KEY = "yorishiro:pending-realtime-start";

export type VoiceEntryAction =
  | { readonly kind: "start" }
  | { readonly kind: "confirm-switch"; readonly agent: AgentDescriptor }
  | { readonly kind: "setup"; readonly agent: AgentDescriptor | null };

export interface ResolveVoiceEntryActionOptions {
  readonly activeAgent: string;
  readonly agents: readonly AgentDescriptor[];
  readonly resolveCommandPath: (command: string) => Promise<string | null>;
}

/** GPT Live discovery is shown for the Main Agent session, independent of its harness. */
export function isVoiceEntryAvailable(activeSessionId: string, mainSessionId: string): boolean {
  return activeSessionId === mainSessionId;
}

/**
 * Voice entry discovery is capability based so another harness can become a realtime target
 * without changing the title-bar flow. Today Codex is the only registered realtime adapter.
 */
export async function resolveVoiceEntryAction({
  activeAgent,
  agents,
  resolveCommandPath,
}: ResolveVoiceEntryActionOptions): Promise<VoiceEntryAction> {
  const active = agents.find((agent) => agent.id === activeAgent);
  if (active?.capabilities.realtimeConversation === true) {
    return { kind: "start" };
  }

  const target = agents.find((agent) => agent.capabilities.realtimeConversation);
  if (target === undefined) {
    return { kind: "setup", agent: null };
  }

  const commandPath = await resolveCommandPath(target.binaryName).catch(() => null);
  return commandPath === null
    ? { kind: "setup", agent: target }
    : { kind: "confirm-switch", agent: target };
}

export function markPendingRealtimeStart(storage: Storage = sessionStorage): void {
  try {
    storage.setItem(PENDING_REALTIME_START_KEY, "1");
  } catch {
    // Storage is best-effort; agent switching must still be allowed in restricted WebViews.
  }
}

export function consumePendingRealtimeStart(storage: Storage = sessionStorage): boolean {
  try {
    const pending = storage.getItem(PENDING_REALTIME_START_KEY) === "1";
    storage.removeItem(PENDING_REALTIME_START_KEY);
    return pending;
  } catch {
    return false;
  }
}

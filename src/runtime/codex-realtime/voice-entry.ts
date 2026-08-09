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

/**
 * GPT Live は Main Agent が所有するが、entry 自体は現在表示中の terminal tab に
 * 依存しない。音声会話を続けながら shell tab で作業できるよう常に固定表示する。
 */
export function isVoiceEntryAvailable(): boolean {
  return true;
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

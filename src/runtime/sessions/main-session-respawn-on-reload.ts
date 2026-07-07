import type { SessionDescriptor, SessionId } from "./types";

const PERSONA_GOODBYE_MAIN_RESPAWN_KEY = "yorishiro:persona-goodbye-main-respawn";

interface ReloadFlagStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function getSessionStorage(): ReloadFlagStorage | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage;
}

export function markPersonaGoodbyeMainRespawnPending(
  storage: ReloadFlagStorage | null = getSessionStorage(),
): void {
  try {
    storage?.setItem(PERSONA_GOODBYE_MAIN_RESPAWN_KEY, "1");
  } catch {
    // Storage may be unavailable in restricted WebView modes. In that case
    // the next reload falls back to normal session restore.
  }
}

export function consumePersonaGoodbyeMainRespawnPending(
  storage: ReloadFlagStorage | null = getSessionStorage(),
): boolean {
  try {
    const pending = storage?.getItem(PERSONA_GOODBYE_MAIN_RESPAWN_KEY) === "1";
    if (pending) storage?.removeItem(PERSONA_GOODBYE_MAIN_RESPAWN_KEY);
    return pending;
  } catch {
    return false;
  }
}

export function filterRestoredSessionsForMainRespawn(
  descriptors: ReadonlyArray<SessionDescriptor>,
  mainSessionId: SessionId,
  shouldRespawnMain: boolean,
): ReadonlyArray<SessionDescriptor> {
  if (!shouldRespawnMain) return descriptors;
  return descriptors.filter((descriptor) => descriptor.id !== mainSessionId);
}

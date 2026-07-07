import type { SessionDescriptor, SessionId } from "./types";

const MAIN_SESSION_RESPAWN_KEY = "yorishiro:main-session-respawn";

interface ReloadFlagStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function getSessionStorage(): ReloadFlagStorage | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage;
}

export function markMainSessionRespawnPending(
  storage: ReloadFlagStorage | null = getSessionStorage(),
): void {
  try {
    storage?.setItem(MAIN_SESSION_RESPAWN_KEY, "1");
  } catch {
    // Storage may be unavailable in restricted WebView modes. In that case
    // the next reload falls back to normal session restore.
  }
}

export function consumeMainSessionRespawnPending(
  storage: ReloadFlagStorage | null = getSessionStorage(),
): boolean {
  try {
    const pending = storage?.getItem(MAIN_SESSION_RESPAWN_KEY) === "1";
    if (pending) storage?.removeItem(MAIN_SESSION_RESPAWN_KEY);
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

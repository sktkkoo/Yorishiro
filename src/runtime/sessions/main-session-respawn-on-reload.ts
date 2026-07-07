import type { SessionDescriptor, SessionId } from "./types";

const MAIN_SESSION_RESPAWN_KEY = "yorishiro:main-session-respawn";
const MAIN_SESSION_RESPAWN_RESUME = "resume";
const MAIN_SESSION_RESPAWN_FRESH = "fresh";

export type MainSessionRespawnMode = "none" | "resume" | "fresh";

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
    storage?.setItem(MAIN_SESSION_RESPAWN_KEY, MAIN_SESSION_RESPAWN_RESUME);
  } catch {
    // Storage may be unavailable in restricted WebView modes. In that case
    // the next reload falls back to normal session restore.
  }
}

export function markMainSessionFreshSpawnPending(
  storage: ReloadFlagStorage | null = getSessionStorage(),
): void {
  try {
    storage?.setItem(MAIN_SESSION_RESPAWN_KEY, MAIN_SESSION_RESPAWN_FRESH);
  } catch {
    // Storage may be unavailable in restricted WebView modes. In that case
    // the next reload falls back to normal session restore.
  }
}

export function consumeMainSessionRespawnMode(
  storage: ReloadFlagStorage | null = getSessionStorage(),
): MainSessionRespawnMode {
  try {
    const value = storage?.getItem(MAIN_SESSION_RESPAWN_KEY);
    if (value !== null) storage?.removeItem(MAIN_SESSION_RESPAWN_KEY);
    if (value === MAIN_SESSION_RESPAWN_FRESH) return "fresh";
    if (value === MAIN_SESSION_RESPAWN_RESUME || value === "1") return "resume";
    return "none";
  } catch {
    return "none";
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

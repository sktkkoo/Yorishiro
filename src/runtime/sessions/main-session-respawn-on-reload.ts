import type { SessionDescriptor, SessionId } from "./types";

const MAIN_SESSION_RESPAWN_KEY = "yorishiro:main-session-respawn";
const MAIN_SESSION_RESPAWN_RESUME = "resume";
const MAIN_SESSION_RESPAWN_FRESH = "fresh";
const COLD_BOOT_USER_LAYER_GRACE_MS = 1200;
// Initial value for device verification. Keep this within the reload curtain failsafe.
const RESPAWN_USER_LAYER_GRACE_MS = 4500;

export type MainSessionRespawnMode = "none" | "resume" | "fresh";

let consumedMainSessionRespawnMode: MainSessionRespawnMode | undefined;

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
    consumedMainSessionRespawnMode = undefined;
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
    consumedMainSessionRespawnMode = undefined;
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
    if (value !== null) {
      storage?.removeItem(MAIN_SESSION_RESPAWN_KEY);
      const mode = mainSessionRespawnModeFromValue(value);
      consumedMainSessionRespawnMode = mode;
      return mode;
    }
    return "none";
  } catch {
    return "none";
  }
}

export function peekMainSessionRespawnMode(
  storage: ReloadFlagStorage | null = getSessionStorage(),
): MainSessionRespawnMode {
  if (consumedMainSessionRespawnMode !== undefined) return consumedMainSessionRespawnMode;
  try {
    return mainSessionRespawnModeFromValue(storage?.getItem(MAIN_SESSION_RESPAWN_KEY));
  } catch {
    return "none";
  }
}

export function resolveUserLayerGraceMs(mode: MainSessionRespawnMode): number {
  return mode === "none" ? COLD_BOOT_USER_LAYER_GRACE_MS : RESPAWN_USER_LAYER_GRACE_MS;
}

function mainSessionRespawnModeFromValue(value: string | null | undefined): MainSessionRespawnMode {
  if (value === MAIN_SESSION_RESPAWN_FRESH) return "fresh";
  if (value === MAIN_SESSION_RESPAWN_RESUME || value === "1") return "resume";
  return "none";
}

export function filterRestoredSessionsForMainRespawn(
  descriptors: ReadonlyArray<SessionDescriptor>,
  mainSessionId: SessionId,
  shouldRespawnMain: boolean,
): ReadonlyArray<SessionDescriptor> {
  if (!shouldRespawnMain) return descriptors;
  return descriptors.filter((descriptor) => descriptor.id !== mainSessionId);
}

import { describe, expect, it } from "vitest";
import { RELOAD_CURTAIN_FAILSAFE_MS } from "../../reload-curtain";
import {
  consumeMainSessionRespawnMode,
  filterRestoredSessionsForMainRespawn,
  markMainSessionFreshSpawnPending,
  markMainSessionRespawnPending,
  peekMainSessionRespawnMode,
  resolveUserLayerGraceMs,
} from "./main-session-respawn-on-reload";
import type { SessionDescriptor, SessionId } from "./types";

const MAIN: SessionId = "default-session";

function descriptor(id: SessionId): SessionDescriptor {
  return {
    id,
    profileId: id === MAIN ? "codex" : "shell",
    kind: id === MAIN ? "agent" : "shell",
    label: id,
    cwd: null,
    displayCwd: null,
    startedAt: 1,
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe("main session respawn reload flag", () => {
  it("marks and consumes the pending main respawn once", () => {
    const storage = memoryStorage();

    expect(consumeMainSessionRespawnMode(storage)).toBe("none");
    markMainSessionRespawnPending(storage);

    expect(consumeMainSessionRespawnMode(storage)).toBe("resume");
    expect(consumeMainSessionRespawnMode(storage)).toBe("none");
  });

  it("marks a fresh spawn when persona changes must not resume old agent context", () => {
    const storage = memoryStorage();

    markMainSessionFreshSpawnPending(storage);

    expect(consumeMainSessionRespawnMode(storage)).toBe("fresh");
    expect(consumeMainSessionRespawnMode(storage)).toBe("none");
  });

  it("peeks a pending respawn mode before it is consumed", () => {
    const storage = memoryStorage();

    markMainSessionRespawnPending(storage);

    expect(peekMainSessionRespawnMode(storage)).toBe("resume");
    expect(consumeMainSessionRespawnMode(storage)).toBe("resume");
  });

  it("peeks the cached respawn mode after it is consumed", () => {
    const storage = memoryStorage();

    markMainSessionFreshSpawnPending(storage);

    expect(consumeMainSessionRespawnMode(storage)).toBe("fresh");
    expect(peekMainSessionRespawnMode(storage)).toBe("fresh");
  });

  it("extends user-layer grace only for reload respawns", () => {
    expect(resolveUserLayerGraceMs("none")).toBe(1200);
    expect(resolveUserLayerGraceMs("fresh")).toBe(4500);
    expect(resolveUserLayerGraceMs("resume")).toBe(4500);
    expect(resolveUserLayerGraceMs("fresh")).toBeLessThan(RELOAD_CURTAIN_FAILSAFE_MS);
  });

  it("filters only the main session descriptor when respawn is pending", () => {
    const descriptors = [descriptor(MAIN), descriptor("shell-1"), descriptor("shell-2")];

    expect(filterRestoredSessionsForMainRespawn(descriptors, MAIN, true)).toEqual([
      descriptor("shell-1"),
      descriptor("shell-2"),
    ]);
    expect(filterRestoredSessionsForMainRespawn(descriptors, MAIN, false)).toBe(descriptors);
  });
});

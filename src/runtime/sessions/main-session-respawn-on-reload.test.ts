import { describe, expect, it } from "vitest";
import {
  consumeMainSessionRespawnMode,
  filterRestoredSessionsForMainRespawn,
  markMainSessionFreshSpawnPending,
  markMainSessionRespawnPending,
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

  it("filters only the main session descriptor when respawn is pending", () => {
    const descriptors = [descriptor(MAIN), descriptor("shell-1"), descriptor("shell-2")];

    expect(filterRestoredSessionsForMainRespawn(descriptors, MAIN, true)).toEqual([
      descriptor("shell-1"),
      descriptor("shell-2"),
    ]);
    expect(filterRestoredSessionsForMainRespawn(descriptors, MAIN, false)).toBe(descriptors);
  });
});

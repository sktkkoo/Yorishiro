import { describe, expect, it } from "vitest";
import {
  consumeMainSessionRespawnPending,
  filterRestoredSessionsForMainRespawn,
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

    expect(consumeMainSessionRespawnPending(storage)).toBe(false);
    markMainSessionRespawnPending(storage);

    expect(consumeMainSessionRespawnPending(storage)).toBe(true);
    expect(consumeMainSessionRespawnPending(storage)).toBe(false);
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

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class MockChannel {},
  invoke: mockInvoke,
}));

const { SessionSpawnError, sessionSpawn } = await import("./tauri-commands");

const spawnArgs = {
  sessionId: "main",
  spec: { kind: "agent" as const, agent: "codex", resume: false },
  cols: 80,
  rows: 24,
  cwd: "/workspace",
  onOutput: {} as never,
};

describe("sessionSpawn", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("returns the backend's atomic pre-replacement confirmed session ID", async () => {
    mockInvoke.mockResolvedValueOnce({ replacedConfirmedSessionId: "A" });

    await expect(sessionSpawn(spawnArgs)).resolves.toEqual({
      replacedConfirmedSessionId: "A",
    });
  });

  it("preserves the pre-replacement ID on a structured spawn failure", async () => {
    mockInvoke.mockRejectedValueOnce({
      message: "spawn failed",
      replacedConfirmedSessionId: "A",
    });

    const failure = await sessionSpawn(spawnArgs).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionSpawnError);
    expect(failure).toMatchObject({
      message: "spawn failed",
      replacedConfirmedSessionId: "A",
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import { VoicePlaybackLeaseSync } from "./voice-playback-lease-sync";
import { VoicePlayer } from "./voice-player";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function flushUpdates(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("VoicePlaybackLeaseSync", () => {
  it("keeps the owner when stop succeeds before the older start claim rejects", async () => {
    const startUpdate = deferred();
    const stopUpdate = deferred();
    const update = vi
      .fn()
      .mockReturnValueOnce(startUpdate.promise)
      .mockReturnValueOnce(stopUpdate.promise);
    const player = new VoicePlayer();
    const sync = new VoicePlaybackLeaseSync(player, {
      registerOwner: vi.fn(async () => "owner-a"),
      update,
    });

    const start = sync.setEnabled(false);
    void start.catch(() => {});
    await flushUpdates();
    const stop = sync.setEnabled(true);
    await flushUpdates();

    stopUpdate.resolve();
    await stop;
    startUpdate.reject(new Error("stale generation"));
    await expect(start).rejects.toThrow("stale generation");

    expect(update.mock.calls.map(([state]) => state.generation)).toEqual([1, 2]);
    expect(player.getPlaybackOwnershipState().ownerId).toBe("owner-a");
  });

  it("ignores an older same-generation transport failure after a newer attempt succeeds", async () => {
    const olderUpdate = deferred();
    const newerUpdate = deferred();
    const registerOwner = vi.fn(async () => "owner-a");
    const player = new VoicePlayer();
    const sync = new VoicePlaybackLeaseSync(player, {
      registerOwner,
      update: vi
        .fn()
        .mockReturnValueOnce(olderUpdate.promise)
        .mockReturnValueOnce(newerUpdate.promise),
    });

    const older = sync.setEnabled(true);
    void older.catch(() => {});
    await flushUpdates();
    const newer = sync.setEnabled(true);
    await flushUpdates();

    newerUpdate.resolve();
    await newer;
    olderUpdate.reject(new Error("late transport failure"));
    await expect(older).rejects.toThrow("late transport failure");

    expect(registerOwner).toHaveBeenCalledTimes(1);
    expect(player.getPlaybackOwnershipState().ownerId).toBe("owner-a");
  });

  it("reacquires after the latest update fails", async () => {
    const registerOwner = vi.fn().mockResolvedValueOnce("owner-a").mockResolvedValueOnce("owner-b");
    const update = vi
      .fn()
      .mockRejectedValueOnce(new Error("owner mismatch"))
      .mockResolvedValueOnce(undefined);
    const player = new VoicePlayer();
    const sync = new VoicePlaybackLeaseSync(player, { registerOwner, update });

    await expect(sync.setEnabled(false)).rejects.toThrow("owner mismatch");
    await sync.setEnabled(true);

    expect(registerOwner).toHaveBeenCalledTimes(2);
    expect(player.getPlaybackOwnershipState().ownerId).toBe("owner-b");
  });
});

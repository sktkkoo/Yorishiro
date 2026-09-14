import { describe, expect, it, vi } from "vitest";
import type { AnimationPlayer, AnimationPlayOptions } from "./animation-player";
import { RecordedIdleFoundation } from "./recorded-idle-foundation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function playback() {
  const completion = deferred<void>();
  return {
    id: 1,
    completion: completion.promise,
    setWeight: vi.fn(),
    stop: vi.fn(async () => completion.resolve()),
    cancel: vi.fn(() => completion.resolve()),
  } satisfies Awaited<ReturnType<AnimationPlayer["play"]>>;
}

function setup() {
  const active = playback();
  const preload = vi.fn(async () => true);
  const play = vi.fn(async (_ref: string, _options?: AnimationPlayOptions) => active);
  const foundation = new RecordedIdleFoundation({ preload, play } as unknown as AnimationPlayer);
  return { foundation, preload, play, active };
}

async function flush() {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe("recorded idle foundation", () => {
  it("keeps one reviewed lower-body recording running across upper-body changes", async () => {
    const { foundation, preload, play, active } = setup();
    foundation.update(true, 1);
    expect(play).not.toHaveBeenCalled();
    await foundation.prepare();
    await foundation.prepare();
    expect(preload).toHaveBeenCalledOnce();
    foundation.update(true, 1);
    await flush();
    for (let frame = 0; frame < 600; frame++) foundation.update(true, 1);
    expect(play).toHaveBeenCalledOnce();
    expect(play.mock.calls[0][1]).toMatchObject({
      layer: "foundation",
      mask: "lower-body",
      loop: true,
      speed: 0.9,
    });
    expect(active.stop).not.toHaveBeenCalled();
    expect(active.setWeight).not.toHaveBeenCalled();
  });

  it("scales reduced motion without restarting the attack or replaying the clip", async () => {
    const { foundation, play, active } = setup();
    await foundation.prepare();
    foundation.update(true, 1);
    await flush();
    foundation.update(true, 0.3);
    foundation.update(true, 0.3);
    expect(play).toHaveBeenCalledOnce();
    expect(active.setWeight).toHaveBeenCalledExactlyOnceWith(0.3, 350);
    foundation.update(true, 0);
    expect(active.stop).toHaveBeenCalledOnce();
  });

  it("invalidates a pending load on ownership transfer and rejects its late handle", async () => {
    const { foundation, play, active } = setup();
    const pending = deferred<typeof active>();
    play.mockReturnValueOnce(pending.promise);
    await foundation.prepare();
    foundation.update(true, 1);
    const guard = play.mock.calls[0][1]?.isCurrent;
    expect(guard?.()).toBe(true);
    foundation.suspend(0);
    expect(guard?.()).toBe(false);
    pending.resolve(active);
    await flush();
    expect(active.cancel).toHaveBeenCalledOnce();
  });

  it("applies a gain change that arrived while the recording was loading", async () => {
    const { foundation, play, active } = setup();
    const pending = deferred<typeof active>();
    play.mockReturnValueOnce(pending.promise);
    await foundation.prepare();
    foundation.update(true, 1);
    foundation.update(true, 0.2);
    pending.resolve(active);
    await flush();
    expect(active.setWeight).toHaveBeenCalledExactlyOnceWith(0.2, 350);
  });

  it("does not start unavailable recordings or retry failed playback every frame", async () => {
    const { foundation, preload, play } = setup();
    preload.mockResolvedValue(false);
    await foundation.prepare();
    foundation.update(true, 1);
    expect(play).not.toHaveBeenCalled();
    const second = setup();
    second.play.mockRejectedValue(new Error("bad recording"));
    await second.foundation.prepare();
    second.foundation.update(true, 1);
    await flush();
    for (let frame = 0; frame < 600; frame++) second.foundation.update(true, 1);
    expect(second.play).toHaveBeenCalledOnce();
  });

  it("cancels immediately on disposal, including preparation still in flight", async () => {
    const { foundation, preload, play } = setup();
    const pending = deferred<boolean>();
    preload.mockReturnValue(pending.promise);
    const preparing = foundation.prepare();
    foundation.dispose();
    pending.resolve(true);
    await preparing;
    foundation.update(true, 1);
    expect(play).not.toHaveBeenCalled();
    const second = setup();
    await second.foundation.prepare();
    second.foundation.update(true, 1);
    await flush();
    second.foundation.dispose();
    expect(second.active.cancel).toHaveBeenCalledOnce();
  });
});

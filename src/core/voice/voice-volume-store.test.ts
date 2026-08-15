import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampVoiceVolume,
  createPersistedVoiceVolumeSetter,
  VoiceVolumeStore,
} from "./voice-volume-store";

describe("VoiceVolumeStore", () => {
  const store = new VoiceVolumeStore();

  afterEach(() => store.set(1));

  it("defaults to full volume and clamps values to 0..1", () => {
    expect(store.get()).toBe(1);
    expect(store.set(-0.5)).toBe(0);
    expect(store.get()).toBe(0);
    expect(store.set(2)).toBe(1);
    expect(clampVoiceVolume(Number.NaN)).toBe(1);
    expect(clampVoiceVolume(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it("notifies subscribers only when the effective value changes", () => {
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.set(0.4);
    store.set(0.4);
    unsubscribe();
    store.set(0.7);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(0.4);
  });

  it("rolls the immediate value back and rethrows when persistence fails", async () => {
    store.set(0.7);
    const failure = new Error("disk full");
    const setVolume = createPersistedVoiceVolumeSetter(
      vi.fn(async () => {
        throw failure;
      }),
      store,
    );

    const update = setVolume(0.2);
    expect(store.get()).toBe(0.2);
    await expect(update).rejects.toBe(failure);
    expect(store.get()).toBe(0.7);
  });

  it.each([
    { first: "fail", second: "fail", expected: 1 },
    { first: "success", second: "fail", expected: 0.2 },
    { first: "fail", second: "success", expected: 0.8 },
  ] as const)("tracks the durable value for queued $first/$second writes", async ({
    first,
    second,
    expected,
  }) => {
    let durable = 1;
    const controls: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    let queue = Promise.resolve();
    const persist = vi.fn((volume: number) => {
      let resolve: () => void = () => {};
      let reject: (error: Error) => void = () => {};
      const gate = new Promise<void>((gateResolve, gateReject) => {
        resolve = gateResolve;
        reject = gateReject;
      });
      controls.push({ resolve, reject });
      const queued = queue
        .then(() => gate)
        .then(() => {
          durable = volume;
        });
      queue = queued.catch(() => {});
      return queued;
    });
    const setVolume = createPersistedVoiceVolumeSetter(persist, store);
    const firstResult = setVolume(0.2).then(
      () => "success" as const,
      () => "fail" as const,
    );
    const secondResult = setVolume(0.8).then(
      () => "success" as const,
      () => "fail" as const,
    );

    expect(store.get()).toBe(0.8);
    if (first === "success") controls[0].resolve();
    else controls[0].reject(new Error("first write failed"));
    await expect(firstResult).resolves.toBe(first);
    // The older completion must never replace the newest optimistic runtime value.
    expect(store.get()).toBe(0.8);

    if (second === "success") controls[1].resolve();
    else controls[1].reject(new Error("second write failed"));
    await expect(secondResult).resolves.toBe(second);

    expect(durable).toBe(expected);
    expect(store.get()).toBe(expected);
  });

  it("captures the configured store value lazily after App boot", async () => {
    const setVolume = createPersistedVoiceVolumeSetter(
      vi.fn(async () => {
        throw new Error("disk full");
      }),
      store,
    );
    store.set(0.6);

    await expect(setVolume(0.2)).rejects.toThrow("disk full");

    expect(store.get()).toBe(0.6);
  });
});

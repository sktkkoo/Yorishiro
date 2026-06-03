import type { HistoryAPI } from "@charminal/sdk";
import { describe, expect, it, vi } from "vitest";
import type { TweenManager } from "../../core/tween/tween-manager";
import { AmenityPackRegistryImpl } from "../amenity-pack-registry";
import { registerBundledMusicShelf } from "./index";

vi.mock("../../bindings/tauri-commands", () => ({
  systemExec: vi.fn(),
}));

const fakeHistory: HistoryAPI = {
  list: async () => [],
  snapshot: async () => 1,
  restore: async () => true,
};

const fakeTween = () =>
  ({
    start: vi.fn(),
    startVec3: vi.fn(),
    cancel: vi.fn(),
  }) as unknown as TweenManager;

const flushRegistration = async () => {
  await Promise.resolve();
};

describe("registerBundledMusicShelf", () => {
  it("enables music-shelf by default", async () => {
    const registry = new AmenityPackRegistryImpl();
    const disposable = registerBundledMusicShelf({
      registry,
      tweenManager: fakeTween(),
      emitEvent: vi.fn(),
      history: fakeHistory,
    });

    await flushRegistration();

    expect(registry.listEntries().map((entry) => entry.id)).toEqual(["music-shelf"]);
    expect(registry.getActiveSet()).toEqual(["music-shelf"]);
    disposable.dispose();
  });

  it("can honor an explicit disabled config entry", async () => {
    const registry = new AmenityPackRegistryImpl();
    const disposable = registerBundledMusicShelf({
      registry,
      tweenManager: fakeTween(),
      emitEvent: vi.fn(),
      history: fakeHistory,
      defaultEnabled: false,
    });

    await flushRegistration();

    expect(registry.listEntries().map((entry) => entry.id)).toEqual(["music-shelf"]);
    expect(registry.getActiveSet()).toEqual([]);
    disposable.dispose();
  });
});

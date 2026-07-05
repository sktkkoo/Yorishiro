import type { AmenityContext, HistoryAPI } from "@yorishiro/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { systemExec } from "../../bindings/tauri-commands";
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

const makeAmbientAudio = (
  initial = { muted: false, volume: 1 },
): { api: AmenityContext["ambientAudio"]; state: () => { muted: boolean; volume: number } } => {
  let state = initial;
  const api: AmenityContext["ambientAudio"] = {
    getState: () => state,
    setMuted: vi.fn((muted: boolean) => {
      state = { ...state, muted };
    }),
    setVolume: vi.fn((volume: number) => {
      state = { ...state, volume };
    }),
  };
  return { api, state: () => state };
};

const flushRegistration = async () => {
  await Promise.resolve();
};

describe("registerBundledMusicShelf", () => {
  beforeEach(() => {
    vi.mocked(systemExec).mockReset();
  });

  it("enables music-shelf by default", async () => {
    const registry = new AmenityPackRegistryImpl();
    const disposable = registerBundledMusicShelf({
      registry,
      tweenManager: fakeTween(),
      emitEvent: vi.fn(),
      loop: () => {},
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
      loop: () => {},
      history: fakeHistory,
      defaultEnabled: false,
    });

    await flushRegistration();

    expect(registry.listEntries().map((entry) => entry.id)).toEqual(["music-shelf"]);
    expect(registry.getActiveSet()).toEqual([]);
    disposable.dispose();
  });

  it("marks now-playing probes as quiet system.exec calls", async () => {
    vi.mocked(systemExec).mockResolvedValue({
      exitCode: 0,
      stdout: "stopped\n",
      stderr: "",
      durationMs: 1,
    });
    const registry = new AmenityPackRegistryImpl();
    const disposable = registerBundledMusicShelf({
      registry,
      tweenManager: fakeTween(),
      emitEvent: vi.fn(),
      loop: () => {},
      history: fakeHistory,
    });

    await flushRegistration();
    const handle = registry.getActiveHandle("music-shelf");
    const result = await handle?.tools.music_now_playing({});

    expect(result).toEqual({ state: "stopped" });
    expect(systemExec).toHaveBeenCalledWith({
      packId: "music-shelf",
      command: "osascript",
      options: expect.objectContaining({
        input: expect.stringContaining("get player state as string"),
        quiet: true,
      }),
    });
    disposable.dispose();
  });

  it("ducks ambient audio during playback and restores it on pause", async () => {
    vi.mocked(systemExec).mockImplementation(async ({ options }) => {
      const input = options?.input ?? "";
      if (input.includes("get player state as string")) {
        return { exitCode: 0, stdout: "playing\n", stderr: "", durationMs: 1 };
      }
      if (input.includes("name of current track")) {
        return {
          exitCode: 0,
          stdout: "Sample Track\nSample Artist\nSample Album\n",
          stderr: "",
          durationMs: 1,
        };
      }
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    });
    const registry = new AmenityPackRegistryImpl();
    const ambientAudio = makeAmbientAudio({ muted: false, volume: 0.8 });
    const disposable = registerBundledMusicShelf({
      registry,
      tweenManager: fakeTween(),
      ambientAudio: ambientAudio.api,
      emitEvent: vi.fn(),
      loop: () => {},
      history: fakeHistory,
    });

    await flushRegistration();
    const handle = registry.getActiveHandle("music-shelf");

    await handle?.tools.music_play({ ambientDuckVolume: 0.25 });
    expect(ambientAudio.api.setVolume).toHaveBeenCalledWith(0.25);
    expect(ambientAudio.state()).toEqual({ muted: false, volume: 0.25 });

    await handle?.tools.music_pause({});
    expect(ambientAudio.api.setMuted).toHaveBeenCalledWith(false);
    expect(ambientAudio.api.setVolume).toHaveBeenLastCalledWith(0.8);
    expect(ambientAudio.state()).toEqual({ muted: false, volume: 0.8 });

    disposable.dispose();
  });
});

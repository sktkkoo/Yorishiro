import { afterEach, describe, expect, it, vi } from "vitest";
import type { SceneSpec } from "../../sdk/scene";
import type { ScenePackRegistry } from "../scene-pack-registry";
import { initAmbientAudio } from "./wire";

vi.mock("howler", () => {
  return {
    Howl: vi.fn(function (this: unknown, opts: { src: string[]; volume: number }) {
      const instance = {
        url: opts.src[0] ?? "",
        play: vi.fn(),
        fade: vi.fn(),
        unload: vi.fn(),
      };
      return instance;
    }),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

function createMockRegistry(): {
  registry: ScenePackRegistry;
  fire: (scene: SceneSpec | null) => void;
} {
  let listener: ((scene: SceneSpec | null) => void) | null = null;
  const registry: Partial<ScenePackRegistry> = {
    subscribeActive: vi.fn().mockImplementation((l: (s: SceneSpec | null) => void) => {
      listener = l;
      return {
        dispose: () => {
          listener = null;
        },
      };
    }),
    getActiveScene: vi.fn().mockReturnValue(null),
  };
  return {
    registry: registry as ScenePackRegistry,
    fire: (scene) => listener?.(scene),
  };
}

describe("initAmbientAudio", () => {
  it("subscribes to registry on init and calls setMix on subsequent fires", async () => {
    const { Howl } = await import("howler");
    const { registry, fire } = createMockRegistry();

    initAmbientAudio(registry);

    expect(registry.subscribeActive).toHaveBeenCalledTimes(1);

    fire({
      id: "rainy",
      layers: [],
      ambient: [{ src: "/abs/rain.mp3", volume: 0.5 }],
    });

    expect(Howl).toHaveBeenCalledWith(
      expect.objectContaining({ src: ["/abs/rain.mp3"], loop: true }),
    );
  });

  it("calls stopAll-equivalent (empty setMix) when scene becomes null", async () => {
    const { Howl } = await import("howler");
    const { registry, fire } = createMockRegistry();

    initAmbientAudio(registry);
    fire({
      id: "rainy",
      layers: [],
      ambient: [{ src: "/abs/rain.mp3", volume: 0.5 }],
    });

    const howlMock = Howl as unknown as {
      mock: { results: Array<{ value: { fade: ReturnType<typeof vi.fn> } }> };
    };
    const firstResult = howlMock.mock.results[0];
    if (firstResult === undefined) throw new Error("Howl が作られていない");
    const rain = firstResult.value;
    rain.fade.mockClear();

    fire(null);

    expect(rain.fade).toHaveBeenCalledWith(0.5, 0, 500);
  });

  it("filters ambient entries with no volume default to 1.0", async () => {
    const { Howl } = await import("howler");
    const { registry, fire } = createMockRegistry();

    initAmbientAudio(registry);
    fire({
      id: "x",
      layers: [],
      ambient: [{ src: "/abs/a.mp3" }],
    });

    const howlMock = Howl as unknown as {
      mock: { results: Array<{ value: { fade: ReturnType<typeof vi.fn> } }> };
    };
    const lastResult = howlMock.mock.results.at(-1);
    if (lastResult === undefined) throw new Error("Howl が作られていない");
    const last = lastResult.value;
    expect(last.fade).toHaveBeenCalledWith(0, 1.0, 500);
  });
});

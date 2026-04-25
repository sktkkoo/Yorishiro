import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AmbientAudioRuntime } from "./ambient-audio";

// Howler を mock。Howl コンストラクタが呼ばれた pattern を track。
const createdHowls: Array<{
  url: string;
  volume: number;
  loop: boolean;
  play: ReturnType<typeof vi.fn>;
  fade: ReturnType<typeof vi.fn>;
  unload: ReturnType<typeof vi.fn>;
  volumeFn: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("howler", () => {
  return {
    Howl: vi.fn().mockImplementation((opts: { src: string[]; volume: number; loop: boolean }) => {
      const instance = {
        url: opts.src[0] ?? "",
        volume: opts.volume,
        loop: opts.loop,
        play: vi.fn(),
        fade: vi.fn(),
        unload: vi.fn(),
        volumeFn: vi.fn().mockImplementation(function (this: { volume: number }) {
          return this.volume;
        }),
      };
      createdHowls.push(instance);
      return instance;
    }),
  };
});

beforeEach(() => {
  createdHowls.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("AmbientAudioRuntime", () => {
  it("starts with empty active set; stopAll on empty is a no-op", () => {
    const runtime = new AmbientAudioRuntime();
    runtime.stopAll();
    expect(createdHowls).toHaveLength(0);
  });
});

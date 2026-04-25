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
    // `new Howl(...)` が動くよう、通常 function で実装する (arrow function は constructor 不可)
    Howl: vi.fn(function (this: unknown, opts: { src: string[]; volume: number; loop: boolean }) {
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

  it("setMix: add new sounds creates Howl, plays, fades in from 0", () => {
    const runtime = new AmbientAudioRuntime();
    runtime.setMix([{ url: "/a.mp3", volume: 0.5 }]);
    expect(createdHowls).toHaveLength(1);
    const [h] = createdHowls;
    if (h === undefined) throw new Error("Howl が作られていない");
    expect(h.url).toBe("/a.mp3");
    expect(h.loop).toBe(true);
    expect(h.play).toHaveBeenCalledTimes(1);
    expect(h.fade).toHaveBeenCalledWith(0, 0.5, 500);
  });

  it("setMix: removing a sound fades it out", () => {
    const runtime = new AmbientAudioRuntime();
    runtime.setMix([{ url: "/a.mp3", volume: 0.5 }]);
    const [h] = createdHowls;
    if (h === undefined) throw new Error("Howl が作られていない");
    h.fade.mockClear();

    runtime.setMix([]);

    expect(h.fade).toHaveBeenCalledWith(0.5, 0, 500);
  });

  it("setMix: volume change fades existing Howl, no new instance", () => {
    const runtime = new AmbientAudioRuntime();
    runtime.setMix([{ url: "/a.mp3", volume: 0.5 }]);
    const [h] = createdHowls;
    if (h === undefined) throw new Error("Howl が作られていない");
    h.fade.mockClear();
    h.play.mockClear();

    runtime.setMix([{ url: "/a.mp3", volume: 0.8 }]);

    expect(createdHowls).toHaveLength(1); // 新規 Howl は作られない
    expect(h.play).not.toHaveBeenCalled();
    expect(h.fade).toHaveBeenCalledWith(0.5, 0.8, 500);
  });

  it("setMix: unchanged sound is left alone (no fade, no play)", () => {
    const runtime = new AmbientAudioRuntime();
    runtime.setMix([{ url: "/a.mp3", volume: 0.5 }]);
    const [h] = createdHowls;
    if (h === undefined) throw new Error("Howl が作られていない");
    h.fade.mockClear();
    h.play.mockClear();

    runtime.setMix([{ url: "/a.mp3", volume: 0.5 }]);

    expect(h.fade).not.toHaveBeenCalled();
    expect(h.play).not.toHaveBeenCalled();
  });

  it("setMix: mix change preserves shared sound, swaps the rest", () => {
    const runtime = new AmbientAudioRuntime();
    runtime.setMix([
      { url: "/rain.mp3", volume: 0.5 },
      { url: "/cafe.mp3", volume: 0.3 },
    ]);
    const rain = createdHowls.find((h) => h.url === "/rain.mp3");
    const cafe = createdHowls.find((h) => h.url === "/cafe.mp3");
    if (rain === undefined) throw new Error("/rain.mp3 の Howl が作られていない");
    if (cafe === undefined) throw new Error("/cafe.mp3 の Howl が作られていない");
    rain.fade.mockClear();
    cafe.fade.mockClear();

    runtime.setMix([
      { url: "/rain.mp3", volume: 0.5 }, // 同じ → 触らない
      { url: "/wind.mp3", volume: 0.4 }, // 新規
    ]);

    expect(rain.fade).not.toHaveBeenCalled();
    expect(cafe.fade).toHaveBeenCalledWith(0.3, 0, 500);
    const wind = createdHowls.find((h) => h.url === "/wind.mp3");
    if (wind === undefined) throw new Error("/wind.mp3 の Howl が作られていない");
    expect(wind.fade).toHaveBeenCalledWith(0, 0.4, 500);
  });
});

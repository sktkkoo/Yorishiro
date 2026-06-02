import { describe, expect, it, vi } from "vitest";
import type { TweenManager } from "../../core/tween/tween-manager";
import { playStageTransition, type StageSurfaces } from "./stage-transition";

interface StubStyle {
  [key: string]: string;
  width: string;
  minWidth: string;
  flexBasis: string;
  display: string;
  marginTop: string;
}

const stubStyle = (): StubStyle =>
  ({ width: "", minWidth: "", flexBasis: "", display: "", marginTop: "" }) as StubStyle;

const stubEl = () => ({ style: stubStyle() }) as unknown as HTMLElement;

const makeSurfaces = (): StageSurfaces => ({
  shell: stubEl(),
  character: stubEl(),
  chrome: stubEl(),
});

/** start() で setter(to) を即時適用し、completion を即 resolve する mock。呼び出し順を記録。 */
function makeTweenManager(): {
  tm: TweenManager;
  calls: { key: string; from: number; to: number }[];
} {
  const calls: { key: string; from: number; to: number }[] = [];
  const tm = {
    start: vi.fn(
      (
        key: string,
        to: number,
        _ms: number,
        setter: (v: number) => void,
        opts: { from: number },
      ) => {
        calls.push({ key, from: opts.from, to });
        setter(to);
        return { cancel: vi.fn(), completion: Promise.resolve() };
      },
    ),
    cancel: vi.fn(),
  } as unknown as TweenManager;
  return { tm, calls };
}

describe("playStageTransition", () => {
  it("open: chrome を上げてから shell/character を 100vw に広げ、最終状態にする", async () => {
    const surfaces = makeSurfaces();
    const { tm, calls } = makeTweenManager();

    await playStageTransition("open", surfaces, { tweenManager: tm, viewportWidth: () => 1000 });

    // 順序: chrome → shell/char
    const chromeIdx = calls.findIndex((c) => c.key === "stage.chrome");
    const shellIdx = calls.findIndex((c) => c.key === "stage.shell");
    expect(chromeIdx).toBeGreaterThanOrEqual(0);
    expect(shellIdx).toBeGreaterThan(chromeIdx);
    expect(calls.some((c) => c.key === "stage.char")).toBe(true);

    // 最終状態: 全画面 + chrome は隠れる
    expect(surfaces.shell.style.width).toBe("100vw");
    expect(surfaces.shell.style.flexBasis).toBe("100vw");
    expect(surfaces.character.style.width).toBe("100vw");
    expect(surfaces.chrome.style.display).toBe("none");
  });

  it("open: tween completion が来ない場合も最終 fullscreen 状態へ到達する", async () => {
    vi.useFakeTimers();
    try {
      const surfaces = makeSurfaces();
      const tm = {
        start: vi.fn(
          (
            _key: string,
            _to: number,
            _ms: number,
            _setter: (v: number) => void,
            _opts: { from: number },
          ) => ({ cancel: vi.fn(), completion: new Promise<void>(() => {}) }),
        ),
      } as unknown as TweenManager;

      const transition = playStageTransition("open", surfaces, {
        tweenManager: tm,
        viewportWidth: () => 1000,
      });
      await vi.advanceTimersByTimeAsync(4000);
      await transition;

      expect(surfaces.shell.style.width).toBe("100vw");
      expect(surfaces.shell.style.flexBasis).toBe("100vw");
      expect(surfaces.character.style.width).toBe("100vw");
      expect(surfaces.chrome.style.display).toBe("none");
    } finally {
      vi.useRealTimers();
    }
  });

  it("close: shell/character を畳んでから chrome を下ろし、inline を戻す", async () => {
    const surfaces = makeSurfaces();
    const { tm, calls } = makeTweenManager();

    await playStageTransition("close", surfaces, { tweenManager: tm, viewportWidth: () => 1000 });

    // 順序: width → chrome
    const shellIdx = calls.findIndex((c) => c.key === "stage.shell");
    const chromeIdx = calls.findIndex((c) => c.key === "stage.chrome");
    expect(shellIdx).toBeGreaterThanOrEqual(0);
    expect(chromeIdx).toBeGreaterThan(shellIdx);

    // 最終: inline width をクリア（CSS へ返す）、chrome marginTop クリア
    expect(surfaces.shell.style.width).toBe("");
    expect(surfaces.shell.style.flexBasis).toBe("");
    expect(surfaces.character.style.width).toBe("");
    expect(surfaces.chrome.style.marginTop).toBe("");
  });
});

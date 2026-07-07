// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RELOAD_CURTAIN_FADE_MS,
  RELOAD_CURTAIN_FAILSAFE_MS,
  RELOAD_CURTAIN_MIN_VISIBLE_MS,
  RELOAD_CURTAIN_STORAGE_KEY,
  useReloadCurtain,
} from "./reload-curtain";

describe("useReloadCurtain", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    sessionStorage.clear();
  });

  it("pending なしで mount すると hidden のまま", () => {
    const { result } = renderHook(() => useReloadCurtain(false, vi.fn()));
    expect(result.current.phase).toBe("hidden");
  });

  it("beginCurtainReload で fade-in し、pending を立ててから reload する", () => {
    const reload = vi.fn();
    const { result } = renderHook(() => useReloadCurtain(false, reload));

    act(() => {
      result.current.beginCurtainReload();
    });
    expect(result.current.phase).toBe("entering");
    expect(sessionStorage.getItem(RELOAD_CURTAIN_STORAGE_KEY)).toBe("1");

    // rAF で visible へ
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current.phase).toBe("visible");
    expect(reload).not.toHaveBeenCalled();

    // fade 完了 + 猶予の後に reload が 1 回だけ呼ばれる
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("fade-in の paint を待ってから reload タイマーを始める", () => {
    const reload = vi.fn();
    const { result } = renderHook(() => useReloadCurtain(false, reload));

    act(() => {
      result.current.beginCurtainReload();
    });
    act(() => {
      vi.advanceTimersByTime(RELOAD_CURTAIN_FADE_MS + 80);
    });
    expect(reload).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("beginCurtainReload の二重呼び出しでは reload は 1 回", () => {
    const reload = vi.fn();
    const { result } = renderHook(() => useReloadCurtain(false, reload));

    act(() => {
      result.current.beginCurtainReload();
      result.current.beginCurtainReload();
    });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reload 前に async prepareReload を待つ", async () => {
    const reload = vi.fn();
    const prepareReload = vi.fn(async () => {
      await Promise.resolve();
    });
    const { result } = renderHook(() => useReloadCurtain(false, reload));

    let promise!: Promise<void>;
    act(() => {
      promise = result.current.beginCurtainReload(prepareReload);
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    await act(async () => {
      await promise;
    });
    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(prepareReload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(prepareReload.mock.invocationCallOrder[0]).toBeLessThan(
      reload.mock.invocationCallOrder[0],
    );
  });

  it("pending ありで mount すると visible で開始し、ready 後に最低表示時間を満たして開ける", () => {
    sessionStorage.setItem(RELOAD_CURTAIN_STORAGE_KEY, "1");
    const { result, rerender } = renderHook(({ ready }) => useReloadCurtain(ready, vi.fn()), {
      initialProps: { ready: false },
    });
    expect(result.current.phase).toBe("visible");

    rerender({ ready: true });
    expect(result.current.phase).toBe("visible");

    // 最低表示時間の経過で leaving へ、pending も消える
    act(() => {
      vi.advanceTimersByTime(RELOAD_CURTAIN_MIN_VISIBLE_MS);
    });
    expect(result.current.phase).toBe("leaving");
    expect(sessionStorage.getItem(RELOAD_CURTAIN_STORAGE_KEY)).toBeNull();

    // fade-out 完了で hidden
    act(() => {
      vi.advanceTimersByTime(RELOAD_CURTAIN_FADE_MS);
    });
    expect(result.current.phase).toBe("hidden");
  });

  it("ready にならなくても failsafe で必ず開ける", () => {
    sessionStorage.setItem(RELOAD_CURTAIN_STORAGE_KEY, "1");
    const { result } = renderHook(() => useReloadCurtain(false, vi.fn()));
    expect(result.current.phase).toBe("visible");

    act(() => {
      vi.advanceTimersByTime(RELOAD_CURTAIN_FAILSAFE_MS);
    });
    expect(result.current.phase).toBe("leaving");
    expect(sessionStorage.getItem(RELOAD_CURTAIN_STORAGE_KEY)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(RELOAD_CURTAIN_FADE_MS);
    });
    expect(result.current.phase).toBe("hidden");
  });

  it("sessionStorage が使えなくても例外を投げない", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      const { result } = renderHook(() => useReloadCurtain(false, vi.fn()));
      expect(result.current.phase).toBe("hidden");
      expect(() => {
        act(() => {
          result.current.beginCurtainReload();
        });
      }).not.toThrow();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});

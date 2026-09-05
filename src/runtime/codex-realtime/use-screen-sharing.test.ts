// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  screenCaptureFrame,
  screenCaptureListSources,
  screenCaptureRequestPermission,
} from "../../bindings/tauri-commands";
import { useScreenSharing } from "./use-screen-sharing";

vi.mock("../../bindings/tauri-commands", () => ({
  screenCaptureFrame: vi.fn(),
  screenCaptureListSources: vi.fn(),
  screenCaptureRequestPermission: vi.fn(),
}));

const frame = {
  sourceId: 1,
  sourceName: "Display 1",
  dataUrl: "data:image/jpeg;base64,YQ==",
  capturedAt: 1_700_000_000_000,
  width: 1280,
  height: 720,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useScreenSharing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    vi.mocked(screenCaptureListSources).mockResolvedValue([
      { id: 1, name: "Display 1", width: 1920, height: 1080 },
    ]);
    vi.mocked(screenCaptureRequestPermission).mockResolvedValue(true);
    vi.mocked(screenCaptureFrame).mockResolvedValue(frame);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function setup() {
    const share = vi.fn(async () => ({
      status: "shared" as const,
      capturedAt: new Date(frame.capturedAt).toISOString(),
    }));
    const hook = renderHook(
      ({ ownerKey, available }) => useScreenSharing({ available, ownerKey, share }),
      { initialProps: { ownerKey: "main:thread:active", available: true } },
    );
    return { ...hook, share };
  }

  it("lists sources without capture and ignores a permission grant after cancellation", async () => {
    const permission = deferred<boolean>();
    vi.mocked(screenCaptureRequestPermission).mockReturnValue(permission.promise);
    const { result, share } = setup();
    await act(async () => {
      await result.current.refreshSources();
    });
    expect(screenCaptureFrame).not.toHaveBeenCalled();
    let starting!: Promise<void>;
    act(() => {
      starting = result.current.start();
    });
    act(() => result.current.stop());
    await act(async () => {
      permission.resolve(true);
      await starting;
    });
    expect(result.current.active).toBe(false);
    expect(screenCaptureFrame).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
  });

  it("does not overlap captures or deliver a frame after stop", async () => {
    const pending = deferred<typeof frame>();
    vi.mocked(screenCaptureFrame).mockReturnValue(pending.promise);
    const { result, share } = setup();
    await act(async () => {
      await result.current.refreshSources();
    });
    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(screenCaptureFrame).toHaveBeenCalledTimes(1);
    act(() => result.current.stop());
    await act(async () => {
      pending.resolve(frame);
    });
    expect(share).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
  });

  it("supports five-second sampling, deduplicates pixels, and stops on owner change", async () => {
    const { result, rerender, share } = setup();
    await act(async () => {
      await result.current.refreshSources();
    });
    act(() => result.current.setIntervalSeconds(5));
    await act(async () => {
      await result.current.start();
    });
    expect(share).toHaveBeenCalledTimes(1);
    expect(result.current.lastObservedAt).toBe(frame.capturedAt);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screenCaptureFrame).toHaveBeenCalledTimes(2);
    expect(share).toHaveBeenCalledTimes(1);
    rerender({ ownerKey: "main:other-thread:active", available: true });
    expect(result.current.active).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screenCaptureFrame).toHaveBeenCalledTimes(2);
  });

  it("fails visibly without continuing capture when delivery fails", async () => {
    const { result, share } = setup();
    share.mockRejectedValue(new Error("Image context is unsupported"));
    await act(async () => {
      await result.current.refreshSources();
    });
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.active).toBe(false);
    expect(result.current.error).toContain("unsupported");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screenCaptureFrame).toHaveBeenCalledTimes(1);
  });

  it("does not send a burst of images while dragging the interval slider", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.refreshSources();
    });
    await act(async () => {
      await result.current.start();
    });
    for (let value = 5; value <= 60; value++) {
      act(() => result.current.setIntervalSeconds(value));
    }
    expect(screenCaptureFrame).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screenCaptureFrame).toHaveBeenCalledTimes(2);
  });
});

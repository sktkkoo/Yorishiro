// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useViewModeCamera } from "./use-view-mode-camera";
import {
  defaultCameraForCharacter,
  entryCameraForViewMode,
  type WindowedViewMode,
} from "./view-mode-framing";

function cameraRuntime() {
  let anchorY = 1.2;
  let camera = defaultCameraForCharacter();
  const setTarget = vi.fn();
  const release = vi.fn();
  const runtime = {
    getCharacterAnchor: vi.fn(() => ({ x: 0, y: anchorY, z: 0 })),
    setCameraBase: vi.fn(),
    acquireFixedCamera: vi.fn((x: number, y: number, z: number) => {
      const previous = camera;
      camera = { x, y, z };
      return {
        setTarget,
        dispose: () => {
          camera = previous;
          release();
        },
      };
    }),
  };
  return {
    runtime,
    release,
    setTarget,
    get camera() {
      return camera;
    },
    setAnchor: (y: number) => {
      anchorY = y;
    },
    initializeLoadedCamera: () => {
      camera = defaultCameraForCharacter(anchorY);
    },
  };
}

describe("View Mode camera readiness", () => {
  it.each<WindowedViewMode>([
    "portrait",
    "scene",
  ])("%s startup waits for the body and restores the loaded camera on exit", (mode) => {
    const fake = cameraRuntime();
    const { rerender } = renderHook(
      ({ mode, body }: { mode: WindowedViewMode | null; body: object | null }) =>
        useViewModeCamera(mode, body, fake.runtime),
      { initialProps: { mode: mode as WindowedViewMode | null, body: null as object | null } },
    );
    expect(fake.runtime.acquireFixedCamera).not.toHaveBeenCalled();
    fake.initializeLoadedCamera();
    const loadedCamera = fake.camera;
    const body = {};
    rerender({ mode, body });
    expect(fake.camera).toEqual(entryCameraForViewMode(mode, 1.2));
    expect(fake.runtime.acquireFixedCamera).toHaveBeenCalledOnce();
    fake.setAnchor(1.8);
    rerender({ mode, body });
    act(() => window.dispatchEvent(new Event("resize")));
    expect(fake.runtime.acquireFixedCamera).toHaveBeenCalledOnce();
    expect(fake.camera).toEqual(entryCameraForViewMode(mode, 1.2));
    rerender({ mode: null, body });
    expect(fake.release).toHaveBeenCalledOnce();
    expect(fake.camera).toEqual(loadedCamera);
  });

  it("uses the same Call framing for restored startup and entry from Terminal", () => {
    const fake = cameraRuntime();
    const body = {};
    const { rerender, unmount } = renderHook(
      ({ mode }: { mode: WindowedViewMode | null }) => useViewModeCamera(mode, body, fake.runtime),
      { initialProps: { mode: null as WindowedViewMode | null } },
    );
    fake.initializeLoadedCamera();
    rerender({ mode: "portrait" });
    expect(fake.camera).toEqual(entryCameraForViewMode("portrait", 1.2));
    unmount();
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it("does not acquire a stale mode when leaving it before loading completes", () => {
    const fake = cameraRuntime();
    const { rerender } = renderHook(
      ({ mode, body }: { mode: WindowedViewMode | null; body: object | null }) =>
        useViewModeCamera(mode, body, fake.runtime),
      {
        initialProps: { mode: "portrait" as WindowedViewMode | null, body: null as object | null },
      },
    );
    rerender({ mode: null, body: null });
    fake.initializeLoadedCamera();
    rerender({ mode: null, body: {} });
    expect(fake.runtime.acquireFixedCamera).not.toHaveBeenCalled();
    expect(fake.runtime.setCameraBase).toHaveBeenCalledOnce();
  });

  it("releases the old body camera during loading and samples the replacement once", () => {
    const fake = cameraRuntime();
    const { rerender } = renderHook(
      ({ body }: { body: object | null }) => useViewModeCamera("portrait", body, fake.runtime),
      { initialProps: { body: {} as object | null } },
    );
    rerender({ body: null });
    expect(fake.release).toHaveBeenCalledOnce();
    fake.setAnchor(1.8);
    fake.initializeLoadedCamera();
    rerender({ body: {} });
    expect(fake.camera).toEqual(entryCameraForViewMode("portrait", 1.8));
    expect(fake.runtime.acquireFixedCamera).toHaveBeenCalledTimes(2);
  });
});

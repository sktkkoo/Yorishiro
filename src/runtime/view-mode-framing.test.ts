// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  acquireFixedViewModeCamera,
  acquireResponsiveCallCamera,
  CALL_TIER_TRANSITION_MS,
  entryCameraForViewMode,
  resolveCallFramingTier,
} from "./view-mode-framing";

describe("stable View Mode framing", () => {
  it("preserves the tuned Portrait entry composition", () => {
    expect(entryCameraForViewMode("scene")).toEqual({ x: 0, y: 1.31, z: 1.135 });
  });

  it("samples Call's character anchor once and uses a safe fallback", () => {
    const sampled = entryCameraForViewMode("portrait", 1.55);
    expect(sampled.x).toBe(0);
    expect(sampled.y).toBeCloseTo(1.57);
    expect(sampled.z).toBe(0.98);
    expect(entryCameraForViewMode("portrait", null)).toEqual({ x: 0, y: 1.62, z: 0.98 });
  });

  it("does not update camera framing while the window resizes", () => {
    const release = vi.fn();
    const acquire = vi.fn((_x: number, _y: number, _z: number) => ({ dispose: release }));
    let anchorY = 1.55;
    const dispose = acquireFixedViewModeCamera("portrait", acquire, anchorY);

    anchorY = 1.9;
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));

    expect(acquire).toHaveBeenCalledTimes(1);
    const [x, y, z] = acquire.mock.calls[0];
    expect(x).toBe(0);
    expect(y).toBeCloseTo(1.57);
    expect(z).toBe(0.98);
    dispose();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("switches Call tiers with hysteresis and changes only camera distance", () => {
    expect(resolveCallFramingTier(220, "normal")).toBe("small-face");
    expect(resolveCallFramingTier(228, "small-face")).toBe("small-face");
    expect(resolveCallFramingTier(236, "small-face")).toBe("normal");
    const normal = entryCameraForViewMode("portrait", 1.55, "normal");
    const small = entryCameraForViewMode("portrait", 1.55, "small-face");
    expect(small.y).toBe(normal.y);
    expect(normal.z).toBe(0.98);
    expect(small.z).toBe(0.84);
  });

  it("transitions once per Call tier crossing, ignores in-tier resize, and cleans up", () => {
    let width = 250;
    const listeners = new Set<() => void>();
    const setTarget = vi.fn();
    const disposeFixed = vi.fn();
    const acquire = vi.fn((_x: number, _y: number, _z: number) => ({
      setTarget,
      dispose: disposeFixed,
    }));
    const resizeSource = {
      getWidth: () => width,
      addEventListener: (_type: "resize", listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: "resize", listener: () => void) => listeners.delete(listener),
    };
    const release = acquireResponsiveCallCamera(1.55, acquire, resizeSource);
    const resize = () => {
      for (const listener of listeners) listener();
    };

    width = 230;
    resize();
    expect(setTarget).not.toHaveBeenCalled();
    width = 215;
    resize();
    expect(setTarget).toHaveBeenCalledOnce();
    expect(setTarget).toHaveBeenCalledWith(0, expect.closeTo(1.57), 0.84, CALL_TIER_TRANSITION_MS);
    width = 228;
    resize();
    expect(setTarget).toHaveBeenCalledOnce();
    width = 240;
    resize();
    expect(setTarget).toHaveBeenCalledTimes(2);

    release();
    expect(listeners.size).toBe(0);
    expect(disposeFixed).toHaveBeenCalledOnce();
  });
});

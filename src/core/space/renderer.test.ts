import { beforeEach, describe, expect, it, vi } from "vitest";
import { Renderer } from "./renderer";

// Minimal shake target — only the `.style.transform` string is written/read.
interface FakeTarget {
  style: { transform: string };
}

const makeTarget = (): FakeTarget => ({ style: { transform: "" } });

describe("Renderer.addShakeFilter", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "requestAnimationFrame",
      (_cb: FrameRequestCallback): number => 0, // never actually fire in tests
    );
  });

  it("returns a Disposable handle", () => {
    const target = makeTarget();
    const renderer = new Renderer({ shakeTarget: target as unknown as HTMLElement });
    const filter = renderer.addShakeFilter(0.5);
    expect(typeof filter.dispose).toBe("function");
  });

  it("clears the target's transform on dispose", () => {
    const target = makeTarget();
    target.style.transform = "translate(5px, 5px)";
    const renderer = new Renderer({ shakeTarget: target as unknown as HTMLElement });
    const filter = renderer.addShakeFilter(0.5);
    filter.dispose();
    expect(target.style.transform).toBe("");
  });

  it("stops animating after dispose (no new transform writes)", () => {
    const target = makeTarget();
    const frames: Array<() => void> = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
      frames.push(() => cb(0));
      return frames.length;
    });
    const renderer = new Renderer({ shakeTarget: target as unknown as HTMLElement });
    const filter = renderer.addShakeFilter(0.5);
    // First tick runs, sets transform to something
    frames.shift()?.();
    const afterFirstTick = target.style.transform;
    filter.dispose();
    // Drain any remaining queued frames — they should be no-ops after dispose
    while (frames.length > 0) frames.shift()?.();
    // Dispose sets transform back to "" and subsequent frames don't overwrite it
    expect(target.style.transform).toBe("");
    // Sanity check: the first tick had set a non-empty transform
    expect(afterFirstTick).not.toBe("");
  });
});

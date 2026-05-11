// @vitest-environment jsdom

import type { Disposable, EffectContext } from "@charminal/sdk";
import { describe, expect, it, vi } from "vitest";
import screenFlash from "./effect";

function makeCtx(options: Partial<Record<string, unknown>> = {}): {
  ctx: EffectContext<Record<string, unknown>>;
  addDomLayer: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  container: HTMLDivElement;
} {
  const dispose = vi.fn();
  const layer: Disposable = { dispose };
  const container = document.createElement("div");
  const addDomLayer = vi.fn((setup: (c: HTMLDivElement) => void): Disposable => {
    setup(container);
    return layer;
  });
  const ctx = {
    options,
    time: { after: vi.fn(() => Promise.resolve()) },
    signal: { aborted: false } as unknown as AbortSignal,
    renderer: {
      addDomLayer,
      addShakeFilter: vi.fn(),
      addCssFilter: vi.fn(),
      addParticles: vi.fn(),
      drawOnCanvas: vi.fn(),
    },
    audio: { play: vi.fn(async () => {}) },
  } as unknown as EffectContext<Record<string, unknown>>;
  return { ctx, addDomLayer, dispose, container };
}

describe("screen-flash effect", () => {
  it("is declared as an EffectDefinition with id 'screen-flash'", () => {
    expect(screenFlash.id).toBe("screen-flash");
    expect(screenFlash.type).toBe("effect");
  });

  it("adds a DOM layer with a white full-screen overlay by default", async () => {
    const { ctx, addDomLayer, container } = makeCtx();
    await screenFlash.run(ctx, {});
    expect(addDomLayer).toHaveBeenCalledOnce();
    const div = container.firstElementChild as HTMLDivElement | null;
    expect(div).not.toBeNull();
    expect(div?.style.position).toBe("absolute");
    expect(div?.style.pointerEvents).toBe("none");
    // 開始時点では opacity 0、後で peak に上がる
    expect(div?.style.backgroundColor).toBeTruthy();
  });

  it("disposes the DOM layer after the fade sequence", async () => {
    const { ctx, dispose } = makeCtx();
    await screenFlash.run(ctx, { fadeInMs: 30, fadeOutMs: 80 });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("waits for both fade-in and fade-out durations", async () => {
    const after = vi.fn(() => Promise.resolve());
    const container = document.createElement("div");
    const addDomLayer = vi.fn((setup: (c: HTMLDivElement) => void): Disposable => {
      setup(container);
      return { dispose: vi.fn() };
    });
    const ctx = {
      options: {},
      time: { after },
      signal: { aborted: false } as unknown as AbortSignal,
      renderer: {
        addDomLayer,
        addShakeFilter: vi.fn(),
        addCssFilter: vi.fn(),
        addParticles: vi.fn(),
        drawOnCanvas: vi.fn(),
      },
      audio: { play: vi.fn(async () => {}) },
    } as unknown as EffectContext<Record<string, unknown>>;

    await screenFlash.run(ctx, { fadeInMs: 30, fadeOutMs: 80 });
    expect(after).toHaveBeenCalledWith(30);
    expect(after).toHaveBeenCalledWith(80);
  });

  it("still disposes the layer when time.after rejects", async () => {
    const dispose = vi.fn();
    const container = document.createElement("div");
    const addDomLayer = vi.fn((setup: (c: HTMLDivElement) => void): Disposable => {
      setup(container);
      return { dispose };
    });
    const ctx = {
      options: {},
      time: { after: vi.fn(() => Promise.reject(new Error("boom"))) },
      signal: { aborted: false } as unknown as AbortSignal,
      renderer: {
        addDomLayer,
        addShakeFilter: vi.fn(),
        addCssFilter: vi.fn(),
        addParticles: vi.fn(),
        drawOnCanvas: vi.fn(),
      },
      audio: { play: vi.fn(async () => {}) },
    } as unknown as EffectContext<Record<string, unknown>>;

    await expect(screenFlash.run(ctx, {})).rejects.toThrow("boom");
    expect(dispose).toHaveBeenCalledOnce();
  });
});

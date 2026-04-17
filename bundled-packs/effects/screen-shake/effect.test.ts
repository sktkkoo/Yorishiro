import type { Disposable, EffectContext } from "@charminal/sdk";
import { describe, expect, it, vi } from "vitest";
import screenShake from "./effect";

describe("screen-shake effect", () => {
  it("is declared as an EffectDefinition with id 'screen-shake'", () => {
    expect(screenShake.id).toBe("screen-shake");
    expect(screenShake.type).toBe("effect");
  });

  it("calls addShakeFilter once with the requested intensity", async () => {
    const dispose = vi.fn();
    const filter: Disposable = { dispose };
    const addShakeFilter = vi.fn(() => filter);
    const ctx = {
      options: { intensity: 0.3, durationMs: 200 },
      time: { after: vi.fn(() => Promise.resolve()) },
      signal: { aborted: false } as unknown as AbortSignal,
      renderer: {
        addShakeFilter,
        addColorFilter: vi.fn(),
        addParticles: vi.fn(),
        drawOnCanvas: vi.fn(),
      },
      audio: { play: vi.fn(async () => {}) },
    } as unknown as EffectContext<{ intensity: number; durationMs: number }>;

    await screenShake.run(ctx, { intensity: 0.3, durationMs: 200 });

    expect(addShakeFilter).toHaveBeenCalledWith(0.3);
    expect(addShakeFilter).toHaveBeenCalledOnce();
  });

  it("disposes the filter after the requested duration", async () => {
    const dispose = vi.fn();
    const after = vi.fn(() => Promise.resolve());
    const ctx = {
      options: { intensity: 0.3, durationMs: 200 },
      time: { after },
      signal: { aborted: false } as unknown as AbortSignal,
      renderer: {
        addShakeFilter: vi.fn(() => ({ dispose })),
        addColorFilter: vi.fn(),
        addParticles: vi.fn(),
        drawOnCanvas: vi.fn(),
      },
      audio: { play: vi.fn(async () => {}) },
    } as unknown as EffectContext<{ intensity: number; durationMs: number }>;

    await screenShake.run(ctx, { intensity: 0.3, durationMs: 200 });

    expect(after).toHaveBeenCalledWith(200);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("still disposes the filter when time.after rejects", async () => {
    const dispose = vi.fn();
    const ctx = {
      options: { intensity: 0.3, durationMs: 200 },
      time: { after: vi.fn(() => Promise.reject(new Error("boom"))) },
      signal: { aborted: false } as unknown as AbortSignal,
      renderer: {
        addShakeFilter: vi.fn(() => ({ dispose })),
        addColorFilter: vi.fn(),
        addParticles: vi.fn(),
        drawOnCanvas: vi.fn(),
      },
      audio: { play: vi.fn(async () => {}) },
    } as unknown as EffectContext<{ intensity: number; durationMs: number }>;

    await expect(screenShake.run(ctx, { intensity: 0.3, durationMs: 200 })).rejects.toThrow("boom");
    expect(dispose).toHaveBeenCalledOnce();
  });
});

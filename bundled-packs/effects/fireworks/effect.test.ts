import type { EffectContext, Vec2 } from "@charminal/sdk";
import { describe, expect, it, vi } from "vitest";
import fireworks from "./effect";

/**
 * fireworks effect pack の unit test。
 *
 * 粒の具体的な動き（速度・gravity・色の hue 値など）は brittle になるため
 * test しない。肌触り parameter は帰納的に実装中で調整する
 * （CLAUDE.md「感触 parameter は帰納的に」方針）。
 *
 * ここで守るのは pack の「形」と lifecycle の 4 点のみ：
 *   1. pack が EffectDefinition の shape を満たすこと
 *   2. `drawOnCanvas` が 1 回だけ呼ばれること
 *   3. `time.after(durationMs)` で lifecycle を刻むこと
 *   4. 成功・失敗どちらの経路でも canvas handle が dispose されること
 */

interface FireworksOptions {
  readonly origin: Vec2;
  readonly count: number;
  readonly durationMs: number;
}

/**
 * mock ctx を組み立てる helper。個々の test で必要なフィールドだけ override する。
 * screen-shake の test pattern と同じ構造。
 */
function createMockCtx(overrides: {
  after?: () => Promise<void>;
  drawOnCanvasReturn?: { dispose: ReturnType<typeof vi.fn> };
  drawOnCanvas?: ReturnType<typeof vi.fn>;
}) {
  const dispose = overrides.drawOnCanvasReturn?.dispose ?? vi.fn();
  const drawOnCanvas = overrides.drawOnCanvas ?? vi.fn(() => ({ dispose }));
  const after = vi.fn(overrides.after ?? (() => Promise.resolve()));
  const ctx = {
    options: { origin: { x: 0.5, y: 0.3 }, count: 20, durationMs: 1000 },
    time: { after },
    signal: { aborted: false } as unknown as AbortSignal,
    renderer: {
      addShakeFilter: vi.fn(),
      addColorFilter: vi.fn(),
      addParticles: vi.fn(),
      drawOnCanvas,
    },
    audio: { play: vi.fn(async () => {}) },
  } as unknown as EffectContext<FireworksOptions>;
  return { ctx, dispose, drawOnCanvas, after };
}

describe("fireworks effect", () => {
  it("is declared as an EffectDefinition with id 'fireworks'", () => {
    expect(fireworks.id).toBe("fireworks");
    expect(fireworks.type).toBe("effect");
  });

  it("acquires an overlay canvas via drawOnCanvas exactly once", async () => {
    const { ctx, drawOnCanvas } = createMockCtx({});

    await fireworks.run(ctx, {
      origin: { x: 0.5, y: 0.3 },
      count: 20,
      durationMs: 1000,
    });

    expect(drawOnCanvas).toHaveBeenCalledOnce();
  });

  it("extends a short durationMs so the burst is not cut mid-animation", async () => {
    const { ctx, after } = createMockCtx({});

    await fireworks.run(ctx, {
      origin: { x: 0.5, y: 0.3 },
      count: 20,
      durationMs: 1000, // rise だけで使い切る値
    });

    expect(after).toHaveBeenCalledOnce();
    const arg = after.mock.calls[0][0] as number;
    // 具体値は「感触 parameter」として動かすため bound のみ検証。
    // rise(≈2000ms) + burst tail は少なくとも 3500ms は必要、という下限だけ守る。
    expect(arg).toBeGreaterThanOrEqual(3500);
  });

  it("respects a large durationMs when the caller asks to linger longer than the natural span", async () => {
    const { ctx, after } = createMockCtx({});

    await fireworks.run(ctx, {
      origin: { x: 0.5, y: 0.3 },
      count: 20,
      durationMs: 20_000,
    });

    expect(after).toHaveBeenCalledWith(20_000);
  });

  it("disposes the canvas handle after the requested duration", async () => {
    const { ctx, dispose } = createMockCtx({});

    await fireworks.run(ctx, {
      origin: { x: 0.5, y: 0.3 },
      count: 20,
      durationMs: 1000,
    });

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("still disposes the canvas handle when time.after rejects", async () => {
    const { ctx, dispose } = createMockCtx({
      after: () => Promise.reject(new Error("boom")),
    });

    await expect(
      fireworks.run(ctx, {
        origin: { x: 0.5, y: 0.3 },
        count: 20,
        durationMs: 1000,
      }),
    ).rejects.toThrow("boom");

    expect(dispose).toHaveBeenCalledOnce();
  });
});

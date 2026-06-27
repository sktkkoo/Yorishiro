import type { EffectContext, Vec2 } from "@charminal/sdk";
import { describe, expect, it, vi } from "vitest";
import fireworks from "./effect";

/**
 * fireworks effect pack の unit test。
 *
 * 粒の具体的な動き（速度・gravity・色の hue 値など）と GPU シェーダーの描画は
 * brittle / jsdom で再現不可なため test しない。肌触り parameter は帰納的に
 * 実装中で調整する（CLAUDE.md「感触 parameter は帰納的に」方針）。
 *
 * ここで守るのは pack の「形」と lifecycle の 4 点のみ：
 *   1. pack が EffectDefinition の shape を満たすこと
 *   2. `drawOnGLCanvas` が 1 回だけ呼ばれること（GPU overlay を acquire する）
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
 *
 * drawOnGLCanvas の mock は draw callback を呼ばない（jsdom に WebGL2 が無い）。
 * その結果 effect 内の RAF loop は起動せず、lifecycle（after / dispose）だけが
 * 検証対象になる。
 */
function createMockCtx(overrides: {
  after?: (ms: number) => Promise<void>;
  drawOnGLCanvasReturn?: { dispose: ReturnType<typeof vi.fn> };
  drawOnGLCanvas?: ReturnType<typeof vi.fn>;
}) {
  const dispose = overrides.drawOnGLCanvasReturn?.dispose ?? vi.fn();
  const drawOnGLCanvas = overrides.drawOnGLCanvas ?? vi.fn(() => ({ dispose }));
  // explicit type で (ms: number) signature を渡し、after.mock.calls[0][0] が
  // number として推論されるようにする。
  const after = vi.fn<(ms: number) => Promise<void>>(overrides.after ?? (() => Promise.resolve()));
  const ctx = {
    options: { origin: { x: 0.5, y: 0.3 }, count: 20, durationMs: 1000 },
    time: { after },
    signal: new AbortController().signal,
    renderer: {
      addShakeFilter: vi.fn(),
      addCssFilter: vi.fn(),
      addParticles: vi.fn(),
      drawOnGLCanvas,
    },
    audio: { play: vi.fn(async () => {}) },
  } as unknown as EffectContext<FireworksOptions>;
  return { ctx, dispose, drawOnGLCanvas, after };
}

describe("fireworks effect", () => {
  it("is declared as an EffectDefinition with id 'fireworks'", () => {
    expect(fireworks.id).toBe("fireworks");
    expect(fireworks.type).toBe("effect");
  });

  it("acquires an overlay canvas via drawOnGLCanvas exactly once", async () => {
    const { ctx, drawOnGLCanvas } = createMockCtx({});

    await fireworks.run(ctx, {
      origin: { x: 0.5, y: 0.3 },
      count: 20,
      durationMs: 1000,
    });

    expect(drawOnGLCanvas).toHaveBeenCalledOnce();
  });

  it("extends a short durationMs so the burst is not cut mid-animation", async () => {
    const { ctx, after } = createMockCtx({});

    await fireworks.run(ctx, {
      origin: { x: 0.5, y: 0.3 },
      count: 20,
      durationMs: 1000, // rise だけで使い切る値
    });

    expect(after).toHaveBeenCalledOnce();
    const arg = after.mock.calls[0][0];
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

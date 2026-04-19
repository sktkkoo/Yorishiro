import type { EffectContext, RendererAPI } from "@charminal/sdk";
import { describe, expect, it, vi } from "vitest";
import fireworks from "../fireworks/effect";
import volley from "./effect";

/**
 * fireworks-volley pack の unit test。
 *
 * 具体的な origin 座標・delay 値・jitter の分布は random 依存で brittle
 * になるため verify しない（CLAUDE.md「感触 parameter は帰納的に」方針）。
 *
 * ここで守るのは「連発の形」だけ：
 *   1. pack が EffectDefinition の shape を満たすこと
 *   2. default option で `count` 回ぶん fireworks.run が呼ばれること
 *   3. option で count を上書きできること
 *   4. abort されたら残りの burst が早期に scheduling を止めること
 */

interface FireworksVolleyOptions {
  count?: number;
  originRange?: { x: [number, number]; y: [number, number] };
  delayStepMs?: number;
  delayJitterMs?: number;
  burstCount?: number;
  burstDurationMs?: number;
}

const makeRendererStub = (): RendererAPI => ({
  addShakeFilter: vi.fn(() => ({ dispose: () => {} })),
  addColorFilter: vi.fn(() => ({ dispose: () => {} })),
  addParticles: vi.fn(() => ({ dispose: () => {}, completion: Promise.resolve() })),
  drawOnCanvas: vi.fn(() => ({ dispose: () => {} })),
});

/** fake time：after(ms) が即 resolve する。count は呼び出し回数。 */
function makeCtx(overrides: { aborted?: boolean }): EffectContext<FireworksVolleyOptions> {
  return {
    options: {},
    time: {
      now: () => 0,
      after: vi.fn(async (_ms: number) => {}),
      schedule: vi.fn(),
      every: vi.fn(),
      probability: vi.fn(),
    } as unknown as EffectContext<FireworksVolleyOptions>["time"],
    signal: { aborted: overrides.aborted ?? false } as unknown as AbortSignal,
    renderer: makeRendererStub(),
    audio: { play: vi.fn(async () => {}) },
  };
}

describe("fireworks-volley effect", () => {
  it("is declared as an EffectDefinition with id 'fireworks-volley'", () => {
    expect(volley.id).toBe("fireworks-volley");
    expect(volley.type).toBe("effect");
  });

  it("fires fireworks.run DEFAULTS.count times when options are empty", async () => {
    const spy = vi.spyOn(fireworks, "run").mockImplementation(async () => {});
    const ctx = makeCtx({});

    await volley.run(ctx, {});

    // default count = 3
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  it("honors the count override", async () => {
    const spy = vi.spyOn(fireworks, "run").mockImplementation(async () => {});
    const ctx = makeCtx({});

    await volley.run(ctx, { count: 5 });

    expect(spy).toHaveBeenCalledTimes(5);
    spy.mockRestore();
  });

  it("skips scheduled bursts when ctx.signal is aborted before they fire", async () => {
    const spy = vi.spyOn(fireworks, "run").mockImplementation(async () => {});
    const ctx = makeCtx({ aborted: true });

    await volley.run(ctx, { count: 3 });

    // aborted なら 1 発も走らない
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

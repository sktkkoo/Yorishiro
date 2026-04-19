import type { EffectContext } from "@charminal/sdk";
import { describe, expect, it, vi } from "vitest";
import desaturate from "./effect";

/**
 * desaturate effect pack の unit test。
 *
 * pack の「形」と lifecycle を守る：
 *   1. pack が EffectDefinition の shape を満たすこと
 *   2. addCssFilter が 1 回呼ばれること
 *   3. addCssFilter に正しい filter 文字列が渡ること
 *   4. 成功・失敗どちらの経路でも filter handle が dispose されること
 *   5. intensity 省略時は default 1（完全モノクロ）であること
 */

interface DesaturateOptions {
  readonly durationMs: number;
  readonly intensity?: number;
}

/**
 * mock ctx を組み立てる helper。個々の test で必要なフィールドだけ override する。
 */
function createMockCtx(overrides: {
  after?: () => Promise<void>;
  addCssFilterReturn?: { dispose: ReturnType<typeof vi.fn> };
  addCssFilter?: ReturnType<typeof vi.fn>;
}) {
  const dispose = overrides.addCssFilterReturn?.dispose ?? vi.fn();
  const addCssFilter = overrides.addCssFilter ?? vi.fn(() => ({ dispose }));
  const after = vi.fn(overrides.after ?? (() => Promise.resolve()));
  const ctx = {
    options: { durationMs: 1000 },
    time: { after },
    signal: new AbortController().signal,
    renderer: {
      addShakeFilter: vi.fn(),
      addCssFilter,
      addDomLayer: vi.fn(),
      addParticles: vi.fn(),
      drawOnCanvas: vi.fn(),
      queryTerminalCells: vi.fn(),
    },
    audio: { play: vi.fn(async () => {}) },
  } as unknown as EffectContext<DesaturateOptions>;
  return { ctx, dispose, addCssFilter, after };
}

describe("desaturate effect", () => {
  it("EffectDefinition の shape を満たす（id: 'desaturate', type: 'effect'）", () => {
    expect(desaturate.id).toBe("desaturate");
    expect(desaturate.type).toBe("effect");
  });

  it("singleton が true である", () => {
    expect(desaturate.singleton).toBe(true);
  });

  it("addCssFilter を 1 回だけ呼ぶ", async () => {
    const { ctx, addCssFilter } = createMockCtx({});

    await desaturate.run(ctx, { durationMs: 1000 });

    expect(addCssFilter).toHaveBeenCalledOnce();
  });

  it("intensity 省略時は grayscale(1) を渡す", async () => {
    const { ctx, addCssFilter } = createMockCtx({});

    await desaturate.run(ctx, { durationMs: 1000 });

    expect(addCssFilter).toHaveBeenCalledWith("grayscale(1)");
  });

  it("intensity 指定時は grayscale(intensity) を渡す", async () => {
    const { ctx, addCssFilter } = createMockCtx({});

    await desaturate.run(ctx, { durationMs: 1000, intensity: 0.5 });

    expect(addCssFilter).toHaveBeenCalledWith("grayscale(0.5)");
  });

  it("正常終了時に filter handle を dispose する", async () => {
    const { ctx, dispose } = createMockCtx({});

    await desaturate.run(ctx, { durationMs: 1000 });

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("time.after が reject しても filter handle を dispose する", async () => {
    const { ctx, dispose } = createMockCtx({
      after: () => Promise.reject(new Error("boom")),
    });

    await expect(desaturate.run(ctx, { durationMs: 1000 })).rejects.toThrow("boom");

    expect(dispose).toHaveBeenCalledOnce();
  });
});

import type { EffectContext, EffectDefinition, RendererAPI } from "@charminal/sdk";
import { describe, expect, it, vi } from "vitest";
import { Time } from "../time";
import { EffectDispatcher } from "./effect-dispatcher";
import { EffectPackRunner } from "./effect-pack-runner";

const makeRendererStub = (): RendererAPI => ({
  addShakeFilter: vi.fn(() => ({ dispose: () => {} })),
  addCssFilter: vi.fn(() => ({ dispose: () => {} })),
  addParticles: vi.fn(() => ({ dispose: () => {}, completion: Promise.resolve() })),
  drawOnCanvas: vi.fn(() => ({ dispose: () => {} })),
  addDomLayer: vi.fn(() => ({ dispose: () => {} })),
  queryTerminalCells: vi.fn(() => null),
});

const makeSetup = () => {
  const dispatcher = new EffectDispatcher();
  const renderer = makeRendererStub();
  const time = new Time();
  const runner = new EffectPackRunner({ dispatcher, renderer, time });
  return { dispatcher, renderer, time, runner };
};

describe("EffectPackRunner", () => {
  it("invokes pack.run when dispatcher fires the pack's id", () => {
    const { dispatcher, runner } = makeSetup();
    const run = vi.fn(async () => {});
    const pack: EffectDefinition = { id: "example-effect", type: "effect", run };
    runner.register(pack);

    dispatcher.dispatch({ kind: "example-effect", intensity: 0.5, durationMs: 200 });

    expect(run).toHaveBeenCalledOnce();
  });

  it("passes the full request as options into pack.run", () => {
    const { dispatcher, runner } = makeSetup();
    const run = vi.fn(async () => {});
    runner.register({ id: "example-effect", type: "effect", run });

    const request = { kind: "example-effect", intensity: 0.3, durationMs: 150 };
    dispatcher.dispatch(request);

    expect(run).toHaveBeenCalledWith(expect.any(Object), request);
  });

  it("supplies a context with time / signal / renderer / audio", () => {
    const { dispatcher, renderer, time, runner } = makeSetup();
    let captured: EffectContext | null = null;
    runner.register({
      id: "example-effect",
      type: "effect",
      run: async (ctx) => {
        captured = ctx;
      },
    });

    dispatcher.dispatch({ kind: "example-effect", intensity: 0.2, durationMs: 100 });

    expect(captured).not.toBeNull();
    if (captured) {
      const ctx: EffectContext = captured;
      expect(ctx.time).toBe(time);
      expect(ctx.renderer).toBe(renderer);
      expect(ctx.signal).toBeInstanceOf(AbortSignal);
      expect(ctx.audio).toBeDefined();
    }
  });

  it("does not fire for unrelated kinds", () => {
    const { dispatcher, runner } = makeSetup();
    const run = vi.fn(async () => {});
    runner.register({ id: "example-effect", type: "effect", run });

    dispatcher.dispatch({ kind: "unrelated-effect", intensity: 0.5, durationMs: 200 });

    expect(run).not.toHaveBeenCalled();
  });

  it("unregister stops the pack from firing", () => {
    const { dispatcher, runner } = makeSetup();
    const run = vi.fn(async () => {});
    const handle = runner.register({ id: "example-effect", type: "effect", run });

    handle.dispose();
    dispatcher.dispatch({ kind: "example-effect", intensity: 0.5, durationMs: 200 });

    expect(run).not.toHaveBeenCalled();
  });

  // ── singleton semantics ──────────────────────────────────

  it("singleton pack は 2 回 dispatch で前の ctx.signal が aborted になる", () => {
    const { dispatcher, runner } = makeSetup();
    const signals: AbortSignal[] = [];
    const run = vi.fn(async (ctx: EffectContext) => {
      signals.push(ctx.signal);
    });
    const pack: EffectDefinition = {
      id: "example-effect",
      type: "effect",
      singleton: true,
      run,
    };
    runner.register(pack);

    dispatcher.dispatch({ kind: "example-effect", intensity: 0.5, durationMs: 200 });
    dispatcher.dispatch({ kind: "example-effect", intensity: 0.8, durationMs: 300 });

    expect(run).toHaveBeenCalledTimes(2);
    // 1 回目の signal は abort 済み
    expect(signals[0].aborted).toBe(true);
    // 2 回目（最新）の signal はまだ生きている
    expect(signals[1].aborted).toBe(false);
  });

  it("non-singleton pack は 2 回 dispatch しても前の signal が aborted にならない", () => {
    const { dispatcher, runner } = makeSetup();
    const signals: AbortSignal[] = [];
    const run = vi.fn(async (ctx: EffectContext) => {
      signals.push(ctx.signal);
    });
    const pack: EffectDefinition = {
      id: "example-effect",
      type: "effect",
      run,
    };
    runner.register(pack);

    dispatcher.dispatch({ kind: "example-effect", intensity: 0.5, durationMs: 200 });
    dispatcher.dispatch({ kind: "example-effect", intensity: 0.8, durationMs: 300 });

    expect(run).toHaveBeenCalledTimes(2);
    // singleton でなければ両方とも abort されない
    expect(signals[0].aborted).toBe(false);
    expect(signals[1].aborted).toBe(false);
  });

  it("singleton pack の dispose 後は前の controller が abort されない", () => {
    const { dispatcher, runner } = makeSetup();
    const signals: AbortSignal[] = [];
    const run = vi.fn(async (ctx: EffectContext) => {
      signals.push(ctx.signal);
    });
    const pack: EffectDefinition = {
      id: "example-effect",
      type: "effect",
      singleton: true,
      run,
    };
    const handle = runner.register(pack);

    dispatcher.dispatch({ kind: "example-effect", intensity: 0.5, durationMs: 200 });
    handle.dispose();

    // dispose 後に dispatch しても run は呼ばれず、
    // 前の signal も勝手に abort されない（subscription が切れているため）
    dispatcher.dispatch({ kind: "example-effect", intensity: 0.8, durationMs: 300 });

    expect(run).toHaveBeenCalledTimes(1);
    expect(signals[0].aborted).toBe(false);
  });
});

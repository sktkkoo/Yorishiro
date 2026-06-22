import type { PersonaContext, PersonaDefinition } from "@charminal/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClaiPersona } from "./persona-factory";

/**
 * clai persona の銃撃ち演出 `runShootTimeline` の single-flight 不変条件を守る test。
 *
 * shoot 演出は ~8 秒の重い one-shot cinematic（camera 引き + gun_fire + text-physics）。
 * reaction の signal は persona 単位で連打では abort されない（per-handler ではない）ため、
 * 演出中にショートカットを連打すると複数の timeline が並行起動し、camera-move(singleton)
 * の復元基準や motion slot が壊れる（引きが戻らない / モーションが出ない / 顔が下向きで固まる）。
 * handler 自身が single-flight guard を持つことで、演出中の再発火を無視する。
 */

const SHOOT_REACTION = "mischievous-shoot-shortcut";

function getShootHandler(): (ctx: PersonaContext) => void | Promise<void> {
  const persona = createClaiPersona({
    id: "clai-test",
    name: "Clai",
    systemPromptAddition: "test",
  }) as PersonaDefinition;
  const set = persona.reflex?.responses?.[SHOOT_REACTION];
  if (set === undefined) throw new Error(`reaction '${SHOOT_REACTION}' not found`);
  return set.handlers[0].handler;
}

function createMockCtx() {
  const injectEffect = vi.fn();
  const play = vi.fn(() => ({ cancel: vi.fn(), stop: vi.fn(() => Promise.resolve()) }));
  const ctx = {
    event: { reaction: SHOOT_REACTION, payload: {} },
    time: { after: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) },
    signal: new AbortController().signal,
    character: {
      interrupt: vi.fn(),
      play,
      express: vi.fn(() => ({ release: vi.fn() })),
      gaze: vi.fn(() => ({ release: vi.fn() })),
    },
    voice: { play: vi.fn() },
    space: { injectEffect },
    log: { write: vi.fn() },
    emitEvent: vi.fn(),
  } as unknown as PersonaContext;
  return { ctx, injectEffect, play };
}

function cameraMoveCount(injectEffect: ReturnType<typeof vi.fn>): number {
  return injectEffect.mock.calls.filter((c) => c[0]?.kind === "camera-move").length;
}

describe("clai shoot timeline single-flight", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("演出中の連打では camera-move を二重に inject しない", async () => {
    const handler = getShootHandler();
    const { ctx, injectEffect, play } = createMockCtx();

    // 1 発目: 最初の await(text-physics delay) まで同期実行され camera-move を inject。
    const first = handler(ctx);
    // 2 発目: 演出中の再発火 → guard で無視される。
    const second = handler(ctx);

    expect(cameraMoveCount(injectEffect)).toBe(1);
    expect(play).toHaveBeenCalledTimes(1);

    // 後始末: timeline を完了させて in-flight flag を解除（他 test へ leak させない）。
    await vi.advanceTimersByTimeAsync(10_000);
    await first;
    await second;
  });

  it("演出が完了したあとの発火は再び通る", async () => {
    const handler = getShootHandler();
    const { ctx, injectEffect } = createMockCtx();

    const first = handler(ctx);
    await vi.advanceTimersByTimeAsync(10_000);
    await first;

    // 完了後の 2 発目は通る。
    const second = handler(ctx);
    expect(cameraMoveCount(injectEffect)).toBe(2);

    await vi.advanceTimersByTimeAsync(10_000);
    await second;
  });
});

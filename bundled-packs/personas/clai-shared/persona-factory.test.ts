import type { DispatchEvent, PersonaContext, PersonaDefinition } from "@charminal/sdk";
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

/**
 * idle 中の自動 shoot（いたずら）。idle が 15 分続いた「その到達時」に一度だけ低確率
 * （<= 10%）で発火し、外しても発火しても再判定はせず persona reload（≒アプリ再起動）まで
 * 沈黙する。判定の一度きりは per-instance closure flag（idleShootEvaluated）で表現する。
 * 2026-05-17 に 90s + 30%（5 秒ごとに毎回判定）で一度廃止したが、離席の確証が高い
 * 15 分閾値 + 単発・低確率に侵襲を下げて復活。経緯: docs/decisions/idle-text-physics-removed.md。
 */
describe("clai idle-shoot trigger（15 分 idle で確率発火）", () => {
  const IDLE_THRESHOLD_MS = 900_000; // 15 分

  function buildPersona(): PersonaDefinition {
    return createClaiPersona({
      id: "clai-test",
      name: "Clai",
      systemPromptAddition: "test",
    }) as PersonaDefinition;
  }
  function getIdleTrigger() {
    const trigger = (buildPersona().reflex?.customTriggers ?? []).find(
      (t) => t.id === "clai:idle-shoot",
    );
    if (trigger === undefined) throw new Error("clai:idle-shoot trigger not registered");
    return trigger;
  }
  const idleEvent = (durationMs: number): DispatchEvent =>
    ({ kind: "idle", durationMs, timestamp: 1000 }) as DispatchEvent;

  afterEach(() => vi.restoreAllMocks());

  it("customTriggers に登録されている", () => {
    expect(
      (buildPersona().reflex?.customTriggers ?? []).find((t) => t.id === "clai:idle-shoot"),
    ).toBeDefined();
  });

  it("idle >= 15 分 かつ probability が通れば mischievous-shoot に match", () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // 必ず通す
    expect(getIdleTrigger().match(idleEvent(IDLE_THRESHOLD_MS))).toEqual({
      reaction: "mischievous-shoot",
      payload: { durationMs: IDLE_THRESHOLD_MS },
    });
  });

  it("15 分未満は probability が通っても match しない", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(getIdleTrigger().match(idleEvent(IDLE_THRESHOLD_MS - 1))).toBeNull();
  });

  it("probability が外れれば match しない", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    expect(getIdleTrigger().match(idleEvent(IDLE_THRESHOLD_MS))).toBeNull();
  });

  it("idle 以外の event には match しない", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const nonIdle = { kind: "session-boundary", timestamp: 1000 } as unknown as DispatchEvent;
    expect(getIdleTrigger().match(nonIdle)).toBeNull();
  });

  it("15 分判定は一度きり: 外したら同一 instance では再判定しない（再起動まで）", () => {
    const trigger = (buildPersona().reflex?.customTriggers ?? []).find(
      (t) => t.id === "clai:idle-shoot",
    );
    if (trigger === undefined) throw new Error("clai:idle-shoot trigger not registered");

    // 1 回目: 15 分到達。probability を外す。
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    expect(trigger.match(idleEvent(IDLE_THRESHOLD_MS))).toBeNull();

    // 2 回目: 以降 idle が続いても（probability が通る値でも）二度と評価しない。
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(trigger.match(idleEvent(IDLE_THRESHOLD_MS + 5_000))).toBeNull();
    expect(trigger.match(idleEvent(IDLE_THRESHOLD_MS + 60_000))).toBeNull();
  });

  it("mischievous-shoot reaction は runShootTimeline を1ハンドラだけ持つ", () => {
    const set = buildPersona().reflex?.responses?.["mischievous-shoot"];
    expect(set?.handlers).toHaveLength(1);
  });
});

import type { ExpressionHandle, MotionHandle } from "@yorishiro/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBodyPerformanceCueAdapter } from "./body-adapter";
import type { PerformanceCue } from "./types";

function expressionHandle(): ExpressionHandle {
  return {
    target: { kind: "mood", preset: "happy" },
    requestedIntensity: 0.4,
    effectiveWeight: 0.4,
    setIntensity: vi.fn(),
    release: vi.fn(),
  };
}

function motionHandle(): MotionHandle {
  return {
    source: "system",
    priority: "speech-performance",
    animation: "anim:VRMA_small_nod",
    startedAt: 0,
    release: vi.fn(),
    cancel: vi.fn(),
    isActive: () => true,
    isPreempted: () => false,
    completion: new Promise(() => {}),
  };
}

function cue(overrides: Partial<PerformanceCue> = {}): PerformanceCue {
  return {
    utteranceId: "u1",
    atMs: 0,
    expression: "happy",
    expressionWeight: 0.42,
    gestureIntent: "agree",
    intensity: "small",
    durationMs: 1_200,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createBodyPerformanceCueAdapter", () => {
  it("expressionとgestureを発話演技専用slotへ解決する", () => {
    const expression = expressionHandle();
    const motion = motionHandle();
    const body = {
      acquireExpressionSlot: vi.fn(() => expression),
      acquireMotionSlot: vi.fn(() => motion),
    };
    const adapter = createBodyPerformanceCueAdapter(() => body);

    adapter.onCue(cue(), { scheduledForMs: 0, firedAtMs: 0, lateByMs: 0 });

    expect(body.acquireExpressionSlot).toHaveBeenCalledWith("speech", "mood", "happy", 0.42);
    expect(body.acquireMotionSlot).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "system",
        priority: "speech-performance",
        animation: "anim:VRMA_small_nod",
      }),
    );
  });

  it("neutralは新しいpresetをacquireせず現在の発話演技だけをreleaseする", () => {
    const firstExpression = expressionHandle();
    const firstMotion = motionHandle();
    const body = {
      acquireExpressionSlot: vi.fn(() => firstExpression),
      acquireMotionSlot: vi.fn(() => firstMotion),
    };
    const adapter = createBodyPerformanceCueAdapter(() => body);
    adapter.onCue(cue(), { scheduledForMs: 0, firedAtMs: 0, lateByMs: 0 });

    adapter.onCue(cue({ expression: "neutral", gestureIntent: "none" }), {
      scheduledForMs: 1,
      firedAtMs: 1,
      lateByMs: 0,
    });

    expect(firstExpression.release).toHaveBeenCalledTimes(1);
    expect(firstMotion.release).toHaveBeenCalledWith(180);
    expect(body.acquireExpressionSlot).toHaveBeenCalledTimes(1);
    expect(body.acquireMotionSlot).toHaveBeenCalledTimes(1);
  });

  it("durationとutterance releaseのどちらでも所有handleだけを一度解放する", () => {
    vi.useFakeTimers();
    const expression = expressionHandle();
    const motion = motionHandle();
    const body = {
      acquireExpressionSlot: vi.fn(() => expression),
      acquireMotionSlot: vi.fn(() => motion),
    };
    const adapter = createBodyPerformanceCueAdapter(() => body);
    adapter.onCue(cue({ durationMs: 500 }), {
      scheduledForMs: 0,
      firedAtMs: 0,
      lateByMs: 0,
    });

    vi.advanceTimersByTime(500);
    adapter.onRelease("u1", "completed");

    expect(expression.release).toHaveBeenCalledTimes(1);
    expect(motion.release).toHaveBeenCalledTimes(1);
  });

  it("Bodyが無い間は安全にno-opする", () => {
    const adapter = createBodyPerformanceCueAdapter(() => null);
    expect(() =>
      adapter.onCue(cue(), { scheduledForMs: 0, firedAtMs: 0, lateByMs: 0 }),
    ).not.toThrow();
  });
});

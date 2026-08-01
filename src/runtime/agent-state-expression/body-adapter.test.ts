import type { MotionHandle } from "@yorishiro/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpeechStateExpressionHandle } from "../../core/body";
import { createBodyStateExpressionAdapter } from "./body-adapter";
import type { StateExpressionCue } from "./types";

function motionHandle(): MotionHandle {
  return {
    source: "system",
    priority: "speech-expression",
    animation: "anim:VRMA_small_nod",
    startedAt: 0,
    release: vi.fn(),
    cancel: vi.fn(),
    isActive: () => true,
    isPreempted: () => false,
    completion: new Promise(() => {}),
  };
}

function stateHandle() {
  return { release: vi.fn<() => void>() } satisfies SpeechStateExpressionHandle;
}

function cue(overrides: Partial<StateExpressionCue> = {}): StateExpressionCue {
  return {
    utteranceId: "u1",
    atMs: 0,
    state: "acknowledging",
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

describe("createBodyStateExpressionAdapter", () => {
  it("resolves facial and body cues into speech state-expression slots", () => {
    const motion = motionHandle();
    const state = stateHandle();
    const body = {
      acquireMotionSlot: vi.fn(() => motion),
      acquireSpeechStateExpression: vi.fn(() => state),
    };
    const adapter = createBodyStateExpressionAdapter(() => body);

    adapter.onCue(cue(), { scheduledForMs: 0, firedAtMs: 0, lateByMs: 0 });

    expect(body.acquireSpeechStateExpression).toHaveBeenCalledWith(
      expect.objectContaining({
        preset: "happy",
        intensity: 0.42,
        microexpressionParams: expect.objectContaining({
          engagementBrowWeight: expect.any(Number),
        }),
      }),
    );
    expect(body.acquireMotionSlot).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "system",
        priority: "speech-expression",
        animation: "anim:VRMA_small_nod",
      }),
    );
  });

  it("releases the current speech state without acquiring a neutral preset", () => {
    const firstMotion = motionHandle();
    const firstState = stateHandle();
    const secondState = stateHandle();
    const body = {
      acquireMotionSlot: vi.fn(() => firstMotion),
      acquireSpeechStateExpression: vi
        .fn<() => SpeechStateExpressionHandle>()
        .mockReturnValueOnce(firstState)
        .mockReturnValueOnce(secondState),
    };
    const adapter = createBodyStateExpressionAdapter(() => body);
    adapter.onCue(cue(), { scheduledForMs: 0, firedAtMs: 0, lateByMs: 0 });

    adapter.onCue(cue({ expression: "neutral", gestureIntent: "none" }), {
      scheduledForMs: 1,
      firedAtMs: 1,
      lateByMs: 0,
    });

    expect(firstState.release).toHaveBeenCalledTimes(1);
    expect(secondState.release).not.toHaveBeenCalled();
    expect(firstMotion.release).toHaveBeenCalledWith(180);
    expect(body.acquireSpeechStateExpression).toHaveBeenLastCalledWith(
      expect.objectContaining({ preset: "neutral" }),
    );
    expect(body.acquireMotionSlot).toHaveBeenCalledTimes(1);
  });

  it("releases owned state once when duration and utterance completion overlap", () => {
    vi.useFakeTimers();
    const motion = motionHandle();
    const state = stateHandle();
    const body = {
      acquireMotionSlot: vi.fn(() => motion),
      acquireSpeechStateExpression: vi.fn(() => state),
    };
    const adapter = createBodyStateExpressionAdapter(() => body);
    adapter.onCue(cue({ durationMs: 500 }), {
      scheduledForMs: 0,
      firedAtMs: 0,
      lateByMs: 0,
    });

    vi.advanceTimersByTime(500);
    adapter.onRelease("u1", "completed");

    expect(state.release).toHaveBeenCalledTimes(1);
    expect(motion.release).toHaveBeenCalledTimes(1);
  });

  it("keeps a grounded low-salience profile even without a mood or gesture", () => {
    const state = stateHandle();
    const body = {
      acquireMotionSlot: vi.fn(),
      acquireSpeechStateExpression: vi.fn(() => state),
    };
    const adapter = createBodyStateExpressionAdapter(() => body);

    adapter.onCue(cue({ state: "progressing", expression: "neutral", gestureIntent: "none" }), {
      scheduledForMs: 0,
      firedAtMs: 0,
      lateByMs: 0,
    });
    adapter.onRelease("u1", "completed");

    expect(body.acquireSpeechStateExpression).toHaveBeenCalledWith(
      expect.objectContaining({
        preset: "neutral",
        microexpressionParams: expect.objectContaining({
          engagementBrowWeight: expect.any(Number),
        }),
      }),
    );
    expect(body.acquireMotionSlot).not.toHaveBeenCalled();
    expect(state.release).toHaveBeenCalledOnce();
  });

  it("releases only the state handle owned by each utterance", () => {
    const firstState = stateHandle();
    const secondState = stateHandle();
    const body = {
      acquireMotionSlot: vi.fn(),
      acquireSpeechStateExpression: vi
        .fn<() => SpeechStateExpressionHandle>()
        .mockReturnValueOnce(firstState)
        .mockReturnValueOnce(secondState),
    };
    const adapter = createBodyStateExpressionAdapter(() => body);
    adapter.onCue(cue({ utteranceId: "u1", gestureIntent: "none" }), {
      scheduledForMs: 0,
      firedAtMs: 0,
      lateByMs: 0,
    });
    adapter.onCue(cue({ utteranceId: "u2", gestureIntent: "none" }), {
      scheduledForMs: 1,
      firedAtMs: 1,
      lateByMs: 0,
    });

    adapter.onRelease("u1", "cancelled");

    expect(firstState.release).toHaveBeenCalledOnce();
    expect(secondState.release).not.toHaveBeenCalled();

    adapter.onRelease("u2", "completed");
    expect(secondState.release).toHaveBeenCalledOnce();
  });

  it("Bodyが無い間は安全にno-opする", () => {
    const adapter = createBodyStateExpressionAdapter(() => null);
    expect(() =>
      adapter.onCue(cue(), { scheduledForMs: 0, firedAtMs: 0, lateByMs: 0 }),
    ).not.toThrow();
  });
});

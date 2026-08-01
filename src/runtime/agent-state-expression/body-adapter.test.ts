import type { MotionHandle } from "@yorishiro/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    const body = {
      acquireMotionSlot: vi.fn(() => motion),
      releaseSpeechMood: vi.fn(),
      resetSpeechExpressionParams: vi.fn(),
      setSpeechExpressionParams: vi.fn(),
      setSpeechMood: vi.fn(),
    };
    const adapter = createBodyStateExpressionAdapter(() => body);

    adapter.onCue(cue(), { scheduledForMs: 0, firedAtMs: 0, lateByMs: 0 });

    expect(body.setSpeechMood).toHaveBeenCalledWith("happy", 0.42);
    expect(body.setSpeechExpressionParams).toHaveBeenCalledWith(
      expect.objectContaining({ engagementBrowWeight: expect.any(Number) }),
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
    const body = {
      acquireMotionSlot: vi.fn(() => firstMotion),
      releaseSpeechMood: vi.fn(),
      resetSpeechExpressionParams: vi.fn(),
      setSpeechExpressionParams: vi.fn(),
      setSpeechMood: vi.fn(),
    };
    const adapter = createBodyStateExpressionAdapter(() => body);
    adapter.onCue(cue(), { scheduledForMs: 0, firedAtMs: 0, lateByMs: 0 });

    adapter.onCue(cue({ expression: "neutral", gestureIntent: "none" }), {
      scheduledForMs: 1,
      firedAtMs: 1,
      lateByMs: 0,
    });

    expect(body.releaseSpeechMood).toHaveBeenCalledTimes(1);
    expect(body.resetSpeechExpressionParams).toHaveBeenCalledTimes(1);
    expect(firstMotion.release).toHaveBeenCalledWith(180);
    expect(body.setSpeechMood).toHaveBeenCalledTimes(1);
    expect(body.acquireMotionSlot).toHaveBeenCalledTimes(1);
  });

  it("releases owned state once when duration and utterance completion overlap", () => {
    vi.useFakeTimers();
    const motion = motionHandle();
    const body = {
      acquireMotionSlot: vi.fn(() => motion),
      releaseSpeechMood: vi.fn(),
      resetSpeechExpressionParams: vi.fn(),
      setSpeechExpressionParams: vi.fn(),
      setSpeechMood: vi.fn(),
    };
    const adapter = createBodyStateExpressionAdapter(() => body);
    adapter.onCue(cue({ durationMs: 500 }), {
      scheduledForMs: 0,
      firedAtMs: 0,
      lateByMs: 0,
    });

    vi.advanceTimersByTime(500);
    adapter.onRelease("u1", "completed");

    expect(body.releaseSpeechMood).toHaveBeenCalledTimes(1);
    expect(body.resetSpeechExpressionParams).toHaveBeenCalledTimes(1);
    expect(motion.release).toHaveBeenCalledTimes(1);
  });

  it("keeps a grounded low-salience profile even without a mood or gesture", () => {
    const body = {
      acquireMotionSlot: vi.fn(),
      releaseSpeechMood: vi.fn(),
      resetSpeechExpressionParams: vi.fn(),
      setSpeechExpressionParams: vi.fn(),
      setSpeechMood: vi.fn(),
    };
    const adapter = createBodyStateExpressionAdapter(() => body);

    adapter.onCue(cue({ state: "progressing", expression: "neutral", gestureIntent: "none" }), {
      scheduledForMs: 0,
      firedAtMs: 0,
      lateByMs: 0,
    });
    adapter.onRelease("u1", "completed");

    expect(body.setSpeechExpressionParams).toHaveBeenCalledOnce();
    expect(body.setSpeechMood).not.toHaveBeenCalled();
    expect(body.acquireMotionSlot).not.toHaveBeenCalled();
    expect(body.resetSpeechExpressionParams).toHaveBeenCalledOnce();
  });

  it("Bodyが無い間は安全にno-opする", () => {
    const adapter = createBodyStateExpressionAdapter(() => null);
    expect(() =>
      adapter.onCue(cue(), { scheduledForMs: 0, firedAtMs: 0, lateByMs: 0 }),
    ).not.toThrow();
  });
});

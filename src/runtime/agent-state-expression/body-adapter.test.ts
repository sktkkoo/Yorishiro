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
  it("forwards grounded conversation phase changes without requesting a speech gesture", () => {
    const body = {
      setMotionConversationPhase: vi.fn(),
      acquireSemanticMotion: vi.fn(() => null),
      acquireSpeechStateExpression: vi.fn(() => stateHandle()),
    };
    const adapter = createBodyStateExpressionAdapter(() => body);
    adapter.onConversationPhaseChange?.("user-speaking");
    adapter.onConversationPhaseChange?.("assistant-responding");
    expect(body.setMotionConversationPhase.mock.calls.flat()).toEqual([
      "user-speaking",
      "assistant-responding",
    ]);
    expect(body.acquireSemanticMotion).not.toHaveBeenCalled();
    expect(body.acquireSpeechStateExpression).not.toHaveBeenCalled();
  });

  it("continues the current gesture when a cue update is intentionally declined by the director", () => {
    const motion = motionHandle();
    const firstState = stateHandle();
    const secondState = stateHandle();
    const body = {
      setMotionConversationPhase: vi.fn(),
      acquireSemanticMotion: vi
        .fn<() => MotionHandle | null>()
        .mockReturnValueOnce(motion)
        .mockReturnValueOnce(null),
      acquireSpeechStateExpression: vi
        .fn<() => SpeechStateExpressionHandle>()
        .mockReturnValueOnce(firstState)
        .mockReturnValueOnce(secondState),
    };
    const adapter = createBodyStateExpressionAdapter(() => body);
    adapter.onCue(cue(), { scheduledForMs: 0, firedAtMs: 0, lateByMs: 0 });
    adapter.onCue(cue({ gestureIntent: "reassure" }), {
      scheduledForMs: 400,
      firedAtMs: 400,
      lateByMs: 0,
    });
    expect(firstState.release).toHaveBeenCalledOnce();
    expect(motion.release).not.toHaveBeenCalled();
    adapter.onRelease("u1", "completed");
    expect(secondState.release).toHaveBeenCalledOnce();
    expect(motion.release).toHaveBeenCalledOnce();
  });

  it("does not transfer an old gesture into a replacement Body when no new gesture is selected", () => {
    const motion = motionHandle();
    const firstBody = {
      setMotionConversationPhase: vi.fn(),
      acquireSemanticMotion: vi.fn(() => motion),
      acquireSpeechStateExpression: vi.fn(() => stateHandle()),
    };
    const secondBody = {
      setMotionConversationPhase: vi.fn(),
      acquireSemanticMotion: vi.fn(() => null),
      acquireSpeechStateExpression: vi.fn(() => stateHandle()),
    };
    const getBody = vi.fn().mockReturnValueOnce(firstBody).mockReturnValueOnce(secondBody);
    const adapter = createBodyStateExpressionAdapter(getBody);
    adapter.onCue(cue(), { scheduledForMs: 0, firedAtMs: 0, lateByMs: 0 });
    adapter.onCue(cue(), { scheduledForMs: 400, firedAtMs: 400, lateByMs: 0 });
    expect(motion.release).toHaveBeenCalledOnce();
    adapter.onRelease("u1", "completed");
    expect(motion.release).toHaveBeenCalledOnce();
  });

  it.each([
    "agree",
    "consider",
    "reassure",
    "emphasize",
  ] as const)("passes %s through to the semantic director with no animation alias collapse", (gestureIntent) => {
    const body = {
      setMotionConversationPhase: vi.fn(),
      acquireSemanticMotion: vi.fn(() => motionHandle()),
      acquireSpeechStateExpression: vi.fn(() => stateHandle()),
    };
    const adapter = createBodyStateExpressionAdapter(() => body);
    adapter.onCue(cue({ gestureIntent, intensity: "medium" }), {
      scheduledForMs: 0,
      firedAtMs: 0,
      lateByMs: 0,
    });
    expect(body.acquireSemanticMotion).toHaveBeenCalledWith({
      source: "system",
      priority: "speech-expression",
      intent: gestureIntent,
      context: "speech",
      intensity: 0.65,
    });
    adapter.onRelease("u1", "completed");
  });

  it("still owns and releases the expression when the director declines a repeated gesture", () => {
    const state = stateHandle();
    const body = {
      setMotionConversationPhase: vi.fn(),
      acquireSemanticMotion: vi.fn(() => null),
      acquireSpeechStateExpression: vi.fn(() => state),
    };
    const adapter = createBodyStateExpressionAdapter(() => body);
    adapter.onCue(cue(), { scheduledForMs: 0, firedAtMs: 0, lateByMs: 0 });
    expect(body.acquireSemanticMotion).toHaveBeenCalledOnce();
    adapter.onRelease("u1", "completed");
    expect(state.release).toHaveBeenCalledOnce();
  });

  it("resolves facial and body cues into speech state-expression slots", () => {
    const motion = motionHandle();
    const state = stateHandle();
    const body = {
      setMotionConversationPhase: vi.fn(),
      acquireSemanticMotion: vi.fn(() => motion),
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
    expect(body.acquireSemanticMotion).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "system",
        priority: "speech-expression",
        intent: "agree",
        context: "speech",
        intensity: 0.35,
      }),
    );
  });

  it("updates the face without truncating a recorded gesture when no additional gesture is requested", () => {
    const firstMotion = motionHandle();
    const firstState = stateHandle();
    const secondState = stateHandle();
    const body = {
      setMotionConversationPhase: vi.fn(),
      acquireSemanticMotion: vi.fn(() => firstMotion),
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
    expect(firstMotion.release).not.toHaveBeenCalled();
    expect(body.acquireSpeechStateExpression).toHaveBeenLastCalledWith(
      expect.objectContaining({ preset: "neutral" }),
    );
    expect(body.acquireSemanticMotion).toHaveBeenCalledTimes(1);
    adapter.onRelease("u1", "cancelled");
    expect(firstMotion.release).toHaveBeenCalledWith(180);
  });

  it("releases owned state once when duration and utterance completion overlap", () => {
    vi.useFakeTimers();
    const motion = motionHandle();
    const state = stateHandle();
    const body = {
      setMotionConversationPhase: vi.fn(),
      acquireSemanticMotion: vi.fn(() => motion),
      acquireSpeechStateExpression: vi.fn(() => state),
    };
    const adapter = createBodyStateExpressionAdapter(() => body);
    adapter.onCue(cue({ durationMs: 500 }), {
      scheduledForMs: 0,
      firedAtMs: 0,
      lateByMs: 0,
    });

    vi.advanceTimersByTime(500);
    expect(state.release).toHaveBeenCalledOnce();
    expect(motion.release).not.toHaveBeenCalled();
    adapter.onRelease("u1", "completed");

    expect(state.release).toHaveBeenCalledTimes(1);
    expect(motion.release).toHaveBeenCalledTimes(1);
  });

  it("lets a bounded authored motif finish after its facial expression expires", async () => {
    vi.useFakeTimers();
    let finish!: (result: { reason: "completed" }) => void;
    const motion = {
      ...motionHandle(),
      completion: new Promise<{ reason: "completed" }>((resolve) => {
        finish = resolve;
      }),
    };
    const state = stateHandle();
    const body = {
      setMotionConversationPhase: vi.fn(),
      acquireSemanticMotion: vi.fn(() => motion),
      acquireSpeechStateExpression: vi.fn(() => state),
    };
    const adapter = createBodyStateExpressionAdapter(() => body);
    adapter.onCue(cue({ durationMs: 2_200 }), {
      scheduledForMs: 0,
      firedAtMs: 0,
      lateByMs: 0,
    });
    vi.advanceTimersByTime(4_000);
    expect(state.release).toHaveBeenCalledOnce();
    expect(motion.release).not.toHaveBeenCalled();
    finish({ reason: "completed" });
    await motion.completion;
    adapter.onRelease("u1", "completed");
    expect(state.release).toHaveBeenCalledOnce();
    expect(motion.release).not.toHaveBeenCalled();
  });

  it("keeps a grounded low-salience profile even without a mood or gesture", () => {
    const state = stateHandle();
    const body = {
      setMotionConversationPhase: vi.fn(),
      acquireSemanticMotion: vi.fn(),
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
    expect(body.acquireSemanticMotion).not.toHaveBeenCalled();
    expect(state.release).toHaveBeenCalledOnce();
  });

  it("releases only the state handle owned by each utterance", () => {
    const firstState = stateHandle();
    const secondState = stateHandle();
    const body = {
      setMotionConversationPhase: vi.fn(),
      acquireSemanticMotion: vi.fn(),
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

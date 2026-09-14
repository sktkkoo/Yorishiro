import { describe, expect, it, vi } from "vitest";
import type { StateExpressionClock } from "./scheduler";
import { createVoiceStateExpressionBridge } from "./voice-state-expression-bridge";

class AudioClock implements StateExpressionClock {
  private time = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  setTimeout = (callback: () => void, delay: number) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + delay, callback });
    return id;
  };
  clearTimeout = (id: unknown) => {
    this.timers.delete(id as number);
  };
  advance(ms: number) {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].callback();
    }
    this.time = target;
  }
}

function setup() {
  const clock = new AudioClock();
  const callbacks = {
    onCue: vi.fn(),
    onRelease: vi.fn(),
    onConversationPhaseChange: vi.fn(),
  };
  return { clock, callbacks, bridge: createVoiceStateExpressionBridge(callbacks, clock) };
}

describe("local TTS state expression bridge", () => {
  it("invalidates a completed recovery once without cancelling a later utterance or resetting its phase", () => {
    const { clock, callbacks, bridge } = setup();
    bridge.onPrepared("old", "はい。");
    bridge.onStarted("old", clock.now());
    clock.advance(300);
    bridge.onEnded("old", "completed");
    callbacks.onRelease.mockClear();
    const phaseCount = callbacks.onConversationPhaseChange.mock.calls.length;
    bridge.onInvalidated?.();
    bridge.onInvalidated?.();
    expect(callbacks.onRelease).toHaveBeenCalledExactlyOnceWith("old", "cancelled");
    expect(callbacks.onConversationPhaseChange).toHaveBeenCalledTimes(phaseCount);
    bridge.onPrepared("new", "大丈夫。");
    bridge.onStarted("new", clock.now());
    callbacks.onRelease.mockClear();
    bridge.onEnded("old", "completed");
    bridge.onEnded("old", "disposed");
    bridge.onInvalidated?.();
    expect(callbacks.onRelease).not.toHaveBeenCalled();
    expect(callbacks.onConversationPhaseChange).toHaveBeenLastCalledWith("assistant-speaking");
  });

  it("replaces a completed recovery during new synthesis without invalidating the new pending owner", () => {
    const { clock, callbacks, bridge } = setup();
    bridge.onPrepared("old", "はい。");
    bridge.onStarted("old", clock.now());
    bridge.onEnded("old", "completed");
    callbacks.onRelease.mockClear();
    bridge.onPrepared("new", "大丈夫。");
    expect(callbacks.onRelease).toHaveBeenCalledExactlyOnceWith("old", "replaced");
    bridge.onInvalidated?.();
    bridge.onEnded("old", "stopped");
    expect(callbacks.onRelease).toHaveBeenCalledOnce();
    bridge.onStarted("new", clock.now());
    expect(callbacks.onConversationPhaseChange).toHaveBeenLastCalledWith("assistant-speaking");
  });

  it("grounds neutral explanatory motion in real audio ownership for the entire spoken paragraph", () => {
    const { clock, callbacks, bridge } = setup();
    bridge.onPrepared(
      "explanation",
      "設定画面には三つの項目があります。左側の一覧から対象を選択できます。保存すると変更が反映されます。",
    );
    clock.advance(10_000);
    expect(callbacks.onConversationPhaseChange).not.toHaveBeenCalledWith("assistant-speaking");
    bridge.onStarted("explanation", clock.now());
    clock.advance(30_000);
    expect(callbacks.onCue).not.toHaveBeenCalled();
    expect(callbacks.onRelease).not.toHaveBeenCalled();
    expect(callbacks.onConversationPhaseChange).toHaveBeenLastCalledWith("assistant-speaking");
    bridge.onEnded("explanation", "completed");
    expect(callbacks.onConversationPhaseChange).toHaveBeenLastCalledWith("idle");
  });

  it("anchors unchanged text to actual audio start even after a long local synthesis delay", () => {
    const { clock, callbacks, bridge } = setup();
    const text = "はい。";
    bridge.onPrepared("local-1", text);
    clock.advance(10_000);
    expect(callbacks.onCue).not.toHaveBeenCalled();
    expect(callbacks.onRelease).not.toHaveBeenCalled();
    bridge.onStarted("local-1", clock.now());
    clock.advance(199);
    expect(callbacks.onCue).not.toHaveBeenCalled();
    clock.advance(1);
    expect(text).toBe("はい。");
    expect(callbacks.onCue).toHaveBeenCalledWith(
      expect.objectContaining({ utteranceId: "local-1", gestureIntent: "agree" }),
      { scheduledForMs: 10_200, firedAtMs: 10_200, lateByMs: 0 },
    );
    bridge.onEnded("local-1", "completed");
    expect(callbacks.onRelease).toHaveBeenCalledWith("local-1", "completed");
    expect(callbacks.onConversationPhaseChange.mock.calls.flat()).toEqual([
      "assistant-responding",
      "assistant-speaking",
      "idle",
    ]);
  });

  it("does not switch facial or gesture ownership while the next utterance is only prepared", () => {
    const { clock, callbacks, bridge } = setup();
    bridge.onPrepared("old", "はい。");
    bridge.onStarted("old", clock.now());
    clock.advance(300);
    bridge.onPrepared("next", "大丈夫。");
    clock.advance(3_000);
    expect(callbacks.onCue).toHaveBeenCalledOnce();
    expect(callbacks.onRelease).not.toHaveBeenCalled();
    expect(callbacks.onConversationPhaseChange).toHaveBeenLastCalledWith("assistant-speaking");
    bridge.onStarted("next", clock.now());
    expect(callbacks.onRelease).toHaveBeenCalledExactlyOnceWith("old", "replaced");
    clock.advance(500);
    expect(callbacks.onCue).toHaveBeenLastCalledWith(
      expect.objectContaining({ utteranceId: "next", gestureIntent: "reassure" }),
      expect.any(Object),
    );
    bridge.onEnded("old", "stopped");
    expect(callbacks.onRelease).toHaveBeenCalledOnce();
    expect(callbacks.onConversationPhaseChange).toHaveBeenLastCalledWith("assistant-speaking");
    bridge.onEnded("next", "completed");
  });

  it("releases cancelled utterances and does not let a duplicate end reset a new audio owner", () => {
    const { clock, callbacks, bridge } = setup();
    bridge.onPrepared("local", "はい。");
    bridge.onStarted("local", clock.now());
    clock.advance(200);
    bridge.onEnded("local", "playback-disabled");
    expect(callbacks.onRelease).toHaveBeenCalledWith("local", "cancelled");
    expect(callbacks.onConversationPhaseChange).toHaveBeenLastCalledWith("idle");
    callbacks.onConversationPhaseChange("assistant-speaking");
    const phaseCount = callbacks.onConversationPhaseChange.mock.calls.length;
    bridge.onEnded("local", "completed");
    expect(callbacks.onConversationPhaseChange).toHaveBeenCalledTimes(phaseCount);
    expect(callbacks.onRelease).toHaveBeenCalledOnce();
  });

  it.each([
    "stopped",
    "disposed",
    "unclocked",
  ] as const)("drops prepared cues on %s without inventing audio or expression ownership", (reason) => {
    const { clock, callbacks, bridge } = setup();
    bridge.onPrepared("local", "はい。");
    bridge.onEnded("local", reason);
    bridge.onStarted("local", clock.now());
    clock.advance(10_000);
    expect(callbacks.onCue).not.toHaveBeenCalled();
    expect(callbacks.onRelease).not.toHaveBeenCalled();
    expect(callbacks.onConversationPhaseChange).toHaveBeenLastCalledWith("idle");
  });

  it("ignores superseded preparation and clears delayed cues when audio stops", () => {
    const { clock, callbacks, bridge } = setup();
    bridge.onPrepared("old", "はい。");
    bridge.onPrepared("next", "大丈夫。");
    bridge.onStarted("old", clock.now());
    expect(callbacks.onConversationPhaseChange).not.toHaveBeenCalledWith("assistant-speaking");
    bridge.onStarted("next", clock.now());
    bridge.onEnded("next", "stopped");
    clock.advance(10_000);
    expect(callbacks.onCue).not.toHaveBeenCalled();
    expect(callbacks.onRelease).toHaveBeenCalledExactlyOnceWith("next", "cancelled");
  });
});

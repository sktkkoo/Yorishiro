import { describe, expect, it, vi } from "vitest";
import { RealtimeStateExpressionController } from "./controller";
import type { StateExpressionClock } from "./scheduler";

class FakeClock implements StateExpressionClock {
  timeMs = 0;
  private nextId = 1;
  private readonly timers = new Map<
    number,
    { readonly at: number; readonly callback: () => void }
  >();

  readonly now = (): number => this.timeMs;
  readonly setTimeout = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.timeMs + delayMs, callback });
    return id;
  };
  readonly clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  advance(ms: number): void {
    this.timeMs += ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.timeMs)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}

function setup() {
  const clock = new FakeClock();
  const onCue = vi.fn();
  const onRelease = vi.fn();
  const controller = new RealtimeStateExpressionController(
    { onCue, onRelease },
    {
      silenceCompletionMs: 400,
      responseCompletionSilenceMs: 1_500,
      scheduler: { cueCooldownMs: 0, gestureCooldownMs: 0, repeatCooldownMs: 0 },
    },
    clock,
  );
  return { clock, controller, onCue, onRelease };
}

describe("RealtimeStateExpressionController", () => {
  it("assistant transcriptを変更せずsemantic cueをremote speech clockへ載せる", () => {
    const h = setup();
    const transcript = "はい。";

    h.controller.onTranscriptDelta("assistant", transcript);
    h.controller.observeRemoteSpeech(true);
    h.clock.advance(300);

    expect(transcript).toBe("はい。");
    expect(h.onCue).toHaveBeenCalledWith(
      expect.objectContaining({ gestureIntent: "agree", expression: "relaxed" }),
      expect.objectContaining({ scheduledForMs: 200 }),
    );
  });

  it("audioがtranscriptより先でも最初のspeech clockを保持する", () => {
    const h = setup();
    h.clock.advance(100);
    h.controller.observeRemoteSpeech(true);
    h.clock.advance(40);
    h.controller.onTranscriptDelta("assistant", "いいね。");
    h.clock.advance(700);

    expect(h.onCue).toHaveBeenCalledTimes(1);
    expect(h.onCue.mock.calls[0][1]).toEqual(expect.objectContaining({ scheduledForMs: 390 }));
  });

  it("audio-first cue that arrives beyond the lateness budget is skipped", () => {
    const h = setup();
    h.clock.advance(100);
    h.controller.observeRemoteSpeech(true);
    h.clock.advance(900);

    h.controller.onTranscriptDelta("assistant", "はい。");
    h.clock.advance(1_000);

    expect(h.onCue).not.toHaveBeenCalled();
  });

  it("releases response-owned handles after transcript completion and the resumption window", () => {
    const h = setup();
    h.controller.onTranscriptDelta("assistant", "大丈夫。 ");
    h.controller.observeRemoteSpeech(true);
    h.controller.onTranscriptDone("assistant");

    h.controller.observeRemoteSpeech(false);
    h.clock.advance(399);
    h.controller.observeRemoteSpeech(false);
    expect(h.onRelease).not.toHaveBeenCalled();

    h.clock.advance(1);
    h.controller.observeRemoteSpeech(false);
    expect(h.onRelease).not.toHaveBeenCalled();

    h.clock.advance(1_100);
    expect(h.onRelease).toHaveBeenCalledWith("realtime-1", "completed");
  });

  it("user transcriptをbarge-inとして未発火cueとhandleを即cancelする", () => {
    const h = setup();
    h.controller.onTranscriptDelta("assistant", "そうですね。");
    h.controller.observeRemoteSpeech(true);

    h.controller.onTranscriptDelta("user", "待って");

    expect(h.onRelease).toHaveBeenCalledWith("realtime-1", "cancelled");
    h.clock.advance(5_000);
    expect(h.onCue).not.toHaveBeenCalled();
  });

  it("ignores late assistant callbacks until the interrupted user turn and remote audio finish", () => {
    const h = setup();
    h.controller.onTranscriptDelta("assistant", "はい。");
    h.controller.observeRemoteSpeech(true);

    h.controller.onTranscriptDelta("user", "待って");
    h.controller.onTranscriptDelta("assistant", "ありがとう。");
    h.controller.onTranscriptDone("assistant");
    h.controller.onTranscriptDone("user");
    h.clock.advance(400);
    h.controller.observeRemoteSpeech(false);

    h.controller.onTranscriptDelta("assistant", "いいね。");
    h.controller.observeRemoteSpeech(true);
    h.clock.advance(290);

    expect(h.onCue).toHaveBeenCalledTimes(1);
    expect(h.onCue).toHaveBeenCalledWith(
      expect.objectContaining({ expression: "happy", utteranceId: "realtime-2" }),
      expect.any(Object),
    );
  });

  it("queues the next response transcript before interrupted audio becomes quiet", () => {
    const h = setup();
    h.controller.onTranscriptDelta("assistant", "はい。");
    h.controller.observeRemoteSpeech(true);

    h.controller.onUserSpeechStarted("user-1");
    h.controller.onTranscriptDone("user");
    h.controller.onTranscriptDelta("assistant", "いいね。");
    h.clock.advance(400);
    h.controller.observeRemoteSpeech(false);

    h.controller.observeRemoteSpeech(true);
    h.clock.advance(290);

    expect(h.onCue).toHaveBeenCalledWith(
      expect.objectContaining({ expression: "happy", utteranceId: "realtime-2" }),
      expect.any(Object),
    );
  });

  it("rejects an invalidated item after cross-transport reorder and accepts the next item", () => {
    const h = setup();
    h.controller.onAssistantResponseBoundary("assistant-old");
    h.controller.onTranscriptDelta("assistant", "はい。");
    h.controller.observeRemoteSpeech(true);

    h.controller.onUserSpeechStarted("user-1");
    h.controller.onTranscriptDone("user");
    h.controller.onAssistantResponseBoundary("assistant-old");
    h.controller.onTranscriptDelta("assistant", "ありがとう。");
    h.clock.advance(400);
    h.controller.observeRemoteSpeech(false);

    h.controller.onAssistantResponseBoundary("assistant-new");
    h.controller.onTranscriptDelta("assistant", "いいね。");
    h.controller.onOutputAudioItem("assistant-new");
    h.controller.observeRemoteSpeech(true);
    h.clock.advance(290);

    expect(h.onCue).toHaveBeenCalledTimes(1);
    expect(h.onCue).toHaveBeenCalledWith(
      expect.objectContaining({ expression: "happy", utteranceId: "realtime-2" }),
      expect.any(Object),
    );
  });

  it("accepts a distinct next assistant item before the delayed user transcript done", () => {
    const h = setup();
    h.controller.onAssistantResponseBoundary("assistant-old");
    h.controller.onTranscriptDelta("assistant", "はい。");
    h.controller.observeRemoteSpeech(true);

    h.controller.onUserSpeechStarted("user-1");
    h.controller.onAssistantResponseBoundary("assistant-new");
    h.controller.onTranscriptDelta("assistant", "いいね。");
    h.controller.onTranscriptDone("user");
    h.clock.advance(400);
    h.controller.observeRemoteSpeech(false);

    h.controller.onOutputAudioItem("assistant-new");
    h.controller.observeRemoteSpeech(true);
    h.clock.advance(290);

    expect(h.onCue).toHaveBeenCalledTimes(1);
    expect(h.onCue).toHaveBeenCalledWith(
      expect.objectContaining({ expression: "happy", utteranceId: "realtime-2" }),
      expect.any(Object),
    );
  });

  it("uses output audio metadata for identity without starting the playout clock", () => {
    const h = setup();
    h.clock.advance(100);
    h.controller.onAssistantResponseBoundary("assistant-1");
    h.controller.onTranscriptDelta("assistant", "いいね。");
    h.controller.onOutputAudioItem("assistant-1");

    h.clock.advance(500);
    expect(h.onCue).not.toHaveBeenCalled();

    h.controller.observeRemoteSpeech(true);
    h.clock.advance(289);
    expect(h.onCue).not.toHaveBeenCalled();
    h.clock.advance(1);

    expect(h.onCue).toHaveBeenCalledWith(
      expect.objectContaining({ expression: "happy" }),
      expect.objectContaining({ scheduledForMs: 890 }),
    );
  });

  it("never starts response-owned cues when output audio metadata has no playout", () => {
    const h = setup();
    h.controller.onAssistantResponseBoundary("assistant-1");
    h.controller.onTranscriptDelta("assistant", "いいね。");
    h.controller.onOutputAudioItem("assistant-1");
    h.controller.onTranscriptDone("assistant");

    h.clock.advance(10_000);

    expect(h.onCue).not.toHaveBeenCalled();
    expect(h.onRelease).not.toHaveBeenCalled();
  });

  it("binds a bounded completed audio interval to a late short transcript", () => {
    const h = setup();
    h.clock.advance(100);
    h.controller.observeRemoteSpeech(true);
    h.clock.advance(400);
    h.controller.observeRemoteSpeech(false);

    h.controller.onTranscriptDelta("assistant", "はい。");
    h.controller.onTranscriptDone("assistant");
    h.clock.advance(0);

    expect(h.onCue).toHaveBeenCalledWith(
      expect.objectContaining({ gestureIntent: "agree" }),
      expect.objectContaining({ scheduledForMs: 300, lateByMs: 200 }),
    );
    expect(h.onRelease).not.toHaveBeenCalled();
  });

  it("treats a long waveform gap as resumable while the response can continue", () => {
    const h = setup();
    h.controller.onTranscriptDelta("assistant", "大丈夫。");
    h.controller.observeRemoteSpeech(true);
    h.controller.onTranscriptDone("assistant");
    h.clock.advance(400);
    h.controller.observeRemoteSpeech(false);

    h.clock.advance(800);
    h.controller.observeRemoteSpeech(true);

    expect(h.onRelease).not.toHaveBeenCalled();

    h.clock.advance(400);
    h.controller.observeRemoteSpeech(false);
    h.clock.advance(1_100);
    expect(h.onRelease).toHaveBeenCalledWith("realtime-1", "completed");
  });

  it("completes when transcript done arrives after remote audio already ended", () => {
    const h = setup();
    h.controller.onTranscriptDelta("assistant", "大丈夫。");
    h.controller.observeRemoteSpeech(true);
    h.clock.advance(400);
    h.controller.observeRemoteSpeech(false);

    h.controller.onTranscriptDone("assistant");
    h.clock.advance(1_100);

    expect(h.onRelease).toHaveBeenCalledWith("realtime-1", "completed");
  });

  it("stop/disconnect用cancelAllは現在のutteranceだけを解放する", () => {
    const h = setup();
    h.controller.onTranscriptDelta("assistant", "確認します。");
    h.controller.cancelAll();
    h.controller.cancelAll();

    expect(h.onRelease).toHaveBeenCalledTimes(1);
    expect(h.onRelease).toHaveBeenCalledWith("realtime-1", "cancelled");
  });
});

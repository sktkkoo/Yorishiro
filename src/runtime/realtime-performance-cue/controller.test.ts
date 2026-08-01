import { describe, expect, it, vi } from "vitest";
import { RealtimePerformanceCueController } from "./controller";
import type { PerformanceCueClock } from "./scheduler";

class FakeClock implements PerformanceCueClock {
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
  const controller = new RealtimePerformanceCueController(
    { onCue, onRelease },
    { silenceCompletionMs: 400, scheduler: { cueCooldownMs: 0, gestureCooldownMs: 0 } },
    clock,
  );
  return { clock, controller, onCue, onRelease };
}

describe("RealtimePerformanceCueController", () => {
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
    expect(h.onCue.mock.calls[0][1]).toEqual(
      expect.objectContaining({ scheduledForMs: expect.any(Number) }),
    );
  });

  it("transcript done後の無音で発話所有handleをcompleted releaseする", () => {
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

  it("stop/disconnect用cancelAllは現在のutteranceだけを解放する", () => {
    const h = setup();
    h.controller.onTranscriptDelta("assistant", "確認します。");
    h.controller.cancelAll();
    h.controller.cancelAll();

    expect(h.onRelease).toHaveBeenCalledTimes(1);
    expect(h.onRelease).toHaveBeenCalledWith("realtime-1", "cancelled");
  });
});

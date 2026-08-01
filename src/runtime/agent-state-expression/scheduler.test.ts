import { describe, expect, it, vi } from "vitest";
import { createStateExpressionResolverState, resolveAssistantTranscriptDelta } from "./resolver";
import {
  type StateExpressionClock,
  StateExpressionScheduler,
  type StateExpressionSchedulerCallbacks,
} from "./scheduler";
import type { StateExpressionCue } from "./types";

interface PendingTimer {
  readonly atMs: number;
  readonly callback: () => void;
}

class FakeClock implements StateExpressionClock {
  private timeMs = 0;
  private nextTimerId = 1;
  private readonly timers = new Map<number, PendingTimer>();

  readonly now = (): number => this.timeMs;

  readonly setTimeout = (callback: () => void, delayMs: number): number => {
    const id = this.nextTimerId++;
    this.timers.set(id, { atMs: this.timeMs + Math.max(0, delayMs), callback });
    return id;
  };

  readonly clearTimeout = (handle: unknown): void => {
    if (typeof handle === "number") this.timers.delete(handle);
  };

  advanceBy(deltaMs: number): void {
    const targetMs = this.timeMs + deltaMs;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.atMs <= targetMs)
        .sort(([firstId, first], [secondId, second]) =>
          first.atMs === second.atMs ? firstId - secondId : first.atMs - second.atMs,
        )[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.timeMs = Math.max(this.timeMs, timer.atMs);
      timer.callback();
    }
    this.timeMs = targetMs;
  }

  /** event loop が block され、timer callback を処理できなかった時間を進める。 */
  elapseWithoutTimers(deltaMs: number): void {
    this.timeMs += deltaMs;
  }
}

function cue(overrides: Partial<StateExpressionCue> = {}): StateExpressionCue {
  return {
    utteranceId: "utterance-1",
    atMs: 500,
    expression: "relaxed",
    expressionWeight: 0.3,
    gestureIntent: "agree",
    intensity: "small",
    durationMs: 1_200,
    ...overrides,
  };
}

function harness(options: ConstructorParameters<typeof StateExpressionScheduler>[1] = {}) {
  const clock = new FakeClock();
  const onCue = vi.fn<StateExpressionSchedulerCallbacks["onCue"]>();
  const onRelease = vi.fn<StateExpressionSchedulerCallbacks["onRelease"]>();
  const scheduler = new StateExpressionScheduler({ onCue, onRelease }, options, clock);
  return { clock, onCue, onRelease, scheduler };
}

describe("StateExpressionScheduler", () => {
  it("remote speech start 基準の相対時刻で cue を発火する", () => {
    const h = harness();
    h.scheduler.startUtterance("utterance-1", 0);

    expect(h.scheduler.schedule(cue())).toEqual({ status: "scheduled", scheduledForMs: 500 });
    h.clock.advanceBy(499);
    expect(h.onCue).not.toHaveBeenCalled();
    h.clock.advanceBy(1);

    expect(h.onCue).toHaveBeenCalledWith(
      cue(),
      expect.objectContaining({ scheduledForMs: 500, firedAtMs: 500, lateByMs: 0 }),
    );
  });

  it("speech start より先に届いた cue を queue し、正確な start clock で展開する", () => {
    const h = harness();
    h.scheduler.prepareUtterance("utterance-1");

    expect(h.scheduler.schedule(cue())).toEqual({ status: "queued" });
    h.clock.advanceBy(100);
    expect(h.onCue).not.toHaveBeenCalled();

    h.scheduler.startUtterance("utterance-1", 100);
    h.clock.advanceBy(499);
    expect(h.onCue).not.toHaveBeenCalled();
    h.clock.advanceBy(1);
    expect(h.onCue).toHaveBeenCalledWith(
      cue(),
      expect.objectContaining({ scheduledForMs: 600, firedAtMs: 600 }),
    );
  });

  it("節末で解決した transcript cue は同期到着の小さな遅れなら発火できる", () => {
    const h = harness({ maxLateMs: 450 });
    const resolved = resolveAssistantTranscriptDelta(createStateExpressionResolverState(), {
      utteranceId: "utterance-1",
      delta: "うん、そうですね。",
      phase: "assistant-speaking",
    });
    const resolvedCue = resolved.cues[0];
    expect(resolvedCue).toBeDefined();
    h.scheduler.startUtterance("utterance-1", 0);

    h.clock.advanceBy(resolvedCue.atMs + 200);
    expect(h.scheduler.schedule(resolvedCue).status).toBe("clamped");
    h.clock.advanceBy(0);

    expect(h.onCue).toHaveBeenCalledTimes(1);
  });

  it("許容範囲内の遅着 cue は現在時刻へ clamp する", () => {
    const h = harness({ maxLateMs: 450 });
    h.scheduler.startUtterance("utterance-1", 0);
    h.clock.advanceBy(700);

    expect(h.scheduler.schedule(cue({ atMs: 400 }))).toEqual({
      status: "clamped",
      scheduledForMs: 400,
      lateByMs: 300,
    });
    h.clock.advanceBy(0);

    expect(h.onCue).toHaveBeenCalledWith(
      cue({ atMs: 400 }),
      expect.objectContaining({ firedAtMs: 700, lateByMs: 300 }),
    );
  });

  it("遅すぎる cue は過去分を再生せず skip する", () => {
    const h = harness({ maxLateMs: 450 });
    h.scheduler.startUtterance("utterance-1", 0);
    h.clock.advanceBy(1_000);

    expect(h.scheduler.schedule(cue({ atMs: 400 }))).toEqual({
      status: "skipped",
      reason: "late",
    });
    h.clock.advanceBy(0);
    expect(h.onCue).not.toHaveBeenCalled();
  });

  it("schedule 後に event loop が詰まった cue も発火時に skip する", () => {
    const h = harness({ maxLateMs: 450 });
    h.scheduler.startUtterance("utterance-1", 0);
    h.scheduler.schedule(cue({ atMs: 500 }));

    h.clock.elapseWithoutTimers(1_000);
    h.clock.advanceBy(0);

    expect(h.onCue).not.toHaveBeenCalled();
  });

  it("cancels pending timers and releases the utterance state expression", () => {
    const h = harness();
    h.scheduler.startUtterance("utterance-1", 0);
    h.scheduler.schedule(cue());

    h.scheduler.cancelUtterance("utterance-1");
    h.clock.advanceBy(1_000);

    expect(h.onCue).not.toHaveBeenCalled();
    expect(h.onRelease).toHaveBeenCalledWith("utterance-1", "cancelled");
  });

  it("新しい utterance は前発話を replaced として release する", () => {
    const h = harness();
    h.scheduler.startUtterance("utterance-1", 0);
    h.scheduler.schedule(cue());

    h.scheduler.startUtterance("utterance-2", 100);
    h.clock.advanceBy(1_000);

    expect(h.onCue).not.toHaveBeenCalled();
    expect(h.onRelease).toHaveBeenCalledWith("utterance-1", "replaced");
  });

  it("cue cooldown 中は近接した cue を連打しない", () => {
    const h = harness({ cueCooldownMs: 800, gestureCooldownMs: 0 });
    h.scheduler.startUtterance("utterance-1", 0);
    h.scheduler.schedule(cue({ atMs: 0 }));
    h.scheduler.schedule(cue({ atMs: 300, expression: "happy" }));

    h.clock.advanceBy(0);
    h.clock.advanceBy(300);

    expect(h.onCue).toHaveBeenCalledTimes(1);
  });

  it("gesture cooldown 中も表情は残し、gesture だけ none にする", () => {
    const h = harness({ cueCooldownMs: 0, gestureCooldownMs: 2_200 });
    h.scheduler.startUtterance("utterance-1", 0);
    h.scheduler.schedule(cue({ atMs: 0 }));
    h.scheduler.schedule(cue({ atMs: 900, expression: "happy", gestureIntent: "emphasize" }));

    h.clock.advanceBy(0);
    h.clock.advanceBy(900);

    expect(h.onCue).toHaveBeenCalledTimes(2);
    expect(h.onCue.mock.calls[1][0]).toEqual(
      cue({ atMs: 900, expression: "happy", gestureIntent: "none" }),
    );
  });

  it("同じ cue の重複 notification は一度だけ schedule する", () => {
    const h = harness();
    h.scheduler.startUtterance("utterance-1", 0);

    expect(h.scheduler.schedule(cue()).status).toBe("scheduled");
    expect(h.scheduler.schedule(cue())).toEqual({ status: "skipped", reason: "duplicate" });
    h.clock.advanceBy(500);

    expect(h.onCue).toHaveBeenCalledTimes(1);
  });

  it("audio の自然終了でも pending cue を捨てて release する", () => {
    const h = harness();
    h.scheduler.startUtterance("utterance-1", 0);
    h.scheduler.schedule(cue());

    h.scheduler.completeUtterance("utterance-1");
    h.clock.advanceBy(500);

    expect(h.onCue).not.toHaveBeenCalled();
    expect(h.onRelease).toHaveBeenCalledWith("utterance-1", "completed");
  });

  it("cancelAll は start 前に queue された cue も破棄する", () => {
    const h = harness();
    h.scheduler.prepareUtterance("utterance-1");
    h.scheduler.schedule(cue());

    h.scheduler.cancelAll();
    h.scheduler.startUtterance("utterance-1", 0);
    h.clock.advanceBy(500);

    expect(h.onCue).not.toHaveBeenCalled();
    expect(h.onRelease).toHaveBeenCalledWith("utterance-1", "cancelled");
  });
});

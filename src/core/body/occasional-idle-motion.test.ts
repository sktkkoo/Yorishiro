import { describe, expect, it, vi } from "vitest";
import { type CompletionReason, type MotionHandle, MotionScheduler } from "./motion-scheduler";
import { OccasionalIdleMotion } from "./occasional-idle-motion";

function playback() {
  let finish!: (value: { reason: CompletionReason }) => void;
  const completion = new Promise<{ reason: CompletionReason }>((resolve) => {
    finish = resolve;
  });
  const handle: MotionHandle = {
    source: "idle",
    priority: "idle-fidget",
    animation: "/animations/recorded-idle/survey.vrma",
    startedAt: 0,
    completion,
    release: vi.fn(),
    cancel: vi.fn(),
    isActive: () => true,
    isPreempted: () => false,
  };
  return { handle, finish };
}

function advance(controller: OccasionalIdleMotion, ms: number, eligible = true) {
  while (ms > 0) {
    const delta = Math.min(1_000, ms);
    controller.update(delta, eligible);
    ms -= delta;
  }
}

describe("OccasionalIdleMotion", () => {
  it.each([0, 0.5, 1])("waits 180–300 seconds of eligible idle with random %s", (random) => {
    const play = vi.fn(() => playback().handle);
    const controller = new OccasionalIdleMotion({ play, random: () => random });
    const wait = 180_000 + random * 120_000;
    advance(controller, wait / 2);
    advance(controller, 600_000, false);
    advance(controller, wait / 2 - 1);
    expect(play).not.toHaveBeenCalled();
    controller.update(1, true);
    expect(play).toHaveBeenCalledOnce();
  });

  it("holds one pending/active handle and starts the next interval only after completion", async () => {
    const first = playback();
    const second = playback();
    const play = vi.fn().mockReturnValueOnce(first.handle).mockReturnValue(second.handle);
    const controller = new OccasionalIdleMotion({ play, waitRangeMs: [100, 100] });
    controller.update(100, true);
    advance(controller, 300_000);
    expect(play).toHaveBeenCalledOnce();
    first.finish({ reason: "completed" });
    await Promise.resolve();
    controller.update(99, true);
    expect(play).toHaveBeenCalledOnce();
    controller.update(1, true);
    expect(play).toHaveBeenCalledTimes(2);
    expect(first.handle.release).not.toHaveBeenCalled();
  });

  it("backs off rejected entries without consuming a new multi-minute interval", () => {
    const active = playback();
    const play = vi.fn().mockReturnValueOnce(null).mockReturnValue(active.handle);
    const random = vi.fn(() => 0);
    const controller = new OccasionalIdleMotion({ play, random, waitRangeMs: [100, 100] });
    controller.update(100, true);
    expect(play).toHaveBeenCalledOnce();
    advance(controller, 60_000, false);
    advance(controller, 2_499);
    controller.update(0, true);
    expect(play).toHaveBeenCalledOnce();
    controller.update(1, true);
    expect(play).toHaveBeenCalledTimes(2);
    expect(random).toHaveBeenCalledOnce();
  });

  it("leaves a finite survey uncapped by default until its natural completion", async () => {
    const active = playback();
    const play = vi.fn(() => active.handle);
    const controller = new OccasionalIdleMotion({ play, waitRangeMs: [100, 100] });
    controller.update(100, true);
    advance(controller, 24_700);
    expect(active.handle.release).not.toHaveBeenCalled();
    expect(active.handle.cancel).not.toHaveBeenCalled();
    expect(play).toHaveBeenCalledOnce();
    active.finish({ reason: "completed" });
    await Promise.resolve();
    controller.update(99, true);
    expect(play).toHaveBeenCalledOnce();
  });

  it.each([
    0, 0.5, 1,
  ])("retires a looping variation once after its selected 8–12 seconds (%s)", (random) => {
    const active = playback();
    const play = vi.fn(() => active.handle);
    const controller = new OccasionalIdleMotion({
      play,
      random: () => random,
      waitRangeMs: [25_000, 25_000],
      activeDurationRangeMs: [8_000, 12_000],
    });
    advance(controller, 25_000);
    advance(controller, 8_000 + random * 4_000 - 1);
    controller.update(0, true);
    expect(active.handle.release).not.toHaveBeenCalled();
    controller.update(1, true);
    expect(active.handle.release).toHaveBeenCalledExactlyOnceWith(800);
    expect(active.handle.cancel).not.toHaveBeenCalled();
    advance(controller, 24_000);
    expect(active.handle.release).toHaveBeenCalledOnce();
    expect(play).toHaveBeenCalledOnce();
  });

  it("does not carry a preempted variation's cap into the next handle", async () => {
    const first = playback();
    const second = playback();
    const play = vi.fn().mockReturnValueOnce(first.handle).mockReturnValue(second.handle);
    const controller = new OccasionalIdleMotion({
      play,
      waitRangeMs: [100, 100],
      activeDurationRangeMs: [8_000, 8_000],
    });
    controller.update(100, true);
    advance(controller, 7_500);
    controller.update(0, false, true);
    expect(first.handle.cancel).toHaveBeenCalledOnce();
    controller.update(100, true);
    first.finish({ reason: "preempted" });
    await Promise.resolve();
    advance(controller, 7_999);
    expect(second.handle.release).not.toHaveBeenCalled();
    controller.update(1, true);
    expect(second.handle.release).toHaveBeenCalledExactlyOnceWith(800);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("releases on loss of eligibility and ignores the old handle's late completion", async () => {
    const first = playback();
    const second = playback();
    const play = vi.fn().mockReturnValueOnce(first.handle).mockReturnValue(second.handle);
    const controller = new OccasionalIdleMotion({ play, waitRangeMs: [100, 100] });
    controller.update(100, true);
    controller.update(0, false);
    controller.update(100, false);
    expect(first.handle.release).toHaveBeenCalledExactlyOnceWith(800);
    controller.update(100, true);
    first.finish({ reason: "cancelled" });
    await Promise.resolve();
    advance(controller, 10_000);
    expect(play).toHaveBeenCalledTimes(2);
    controller.update(0, true, true);
    expect(second.handle.cancel).toHaveBeenCalledOnce();
  });

  it("cancels hard ownership immediately even at zero delta and disposes only once", async () => {
    const active = playback();
    const play = vi.fn(() => active.handle);
    const controller = new OccasionalIdleMotion({ play, waitRangeMs: [100, 100] });
    controller.update(100, true);
    controller.update(0, true, true);
    expect(active.handle.cancel).toHaveBeenCalledOnce();
    expect(active.handle.release).not.toHaveBeenCalled();
    controller.dispose();
    controller.dispose();
    active.finish({ reason: "cancelled" });
    await Promise.resolve();
    advance(controller, 600_000);
    expect(play).toHaveBeenCalledOnce();
    expect(active.handle.cancel).toHaveBeenCalledOnce();
  });

  it("disposes an active handle and does not count invalid or suspended-frame time", () => {
    const active = playback();
    const play = vi.fn(() => active.handle);
    const controller = new OccasionalIdleMotion({ play, waitRangeMs: [2_000, 2_000] });
    for (const delta of [0, -10, NaN, Infinity]) controller.update(delta, true);
    controller.update(600_000, true);
    expect(play).not.toHaveBeenCalled();
    controller.update(1_000, true);
    expect(play).toHaveBeenCalledOnce();
    controller.dispose();
    expect(active.handle.cancel).toHaveBeenCalledOnce();
  });

  it("lets the real scheduler invalidate a pending load before a higher-priority gesture", async () => {
    let finishSurvey!: () => void;
    const pendingSurvey = new Promise<void>((resolve) => {
      finishSurvey = resolve;
    });
    const onActivate = vi.fn((request) =>
      request.priority === "idle-fidget" ? pendingSurvey : new Promise<void>(() => {}),
    );
    const onDeactivate = vi.fn();
    const scheduler = new MotionScheduler({ onActivate, onDeactivate, now: () => 0 });
    const controller = new OccasionalIdleMotion({
      play: () =>
        scheduler.request({
          source: "idle",
          priority: "idle-fidget",
          animation: "/animations/recorded-idle/survey.vrma",
        }),
      waitRangeMs: [100, 100],
    });
    controller.update(100, true);
    controller.update(0, false);
    const speech = scheduler.request({
      source: "system",
      priority: "speech-expression",
      animation: "anim:Thankful",
    });
    finishSurvey();
    await Promise.resolve();
    await Promise.resolve();
    expect(speech.isActive()).toBe(true);
    expect(onDeactivate).toHaveBeenCalledExactlyOnceWith(800);
    advance(controller, 10_000, false);
    expect(onActivate).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SilenceFollowup } from "./silence-followup";
import type { ConversationPart, FollowupCandidate } from "./temporary-followup";

const settings = { enabled: true, silenceSeconds: 60, cooldownSeconds: 300 };
describe("SilenceFollowup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());
  function setup(enabled = true) {
    let allowed = true;
    const generate = vi.fn(
      async (
        _parts: readonly ConversationPart[],
        _signal: AbortSignal,
      ): Promise<FollowupCandidate> => ({
        speak: true,
        text: "Want to revisit the color choice?",
      }),
    );
    const speak = vi.fn(async () => {});
    const instance = new SilenceFollowup({ ...settings, enabled }, () => allowed, generate, speak);
    return {
      instance,
      generate,
      speak,
      disallow: () => {
        allowed = false;
      },
    };
  }
  it("does nothing without explicit opt-in or a completed user part", async () => {
    const off = setup(false);
    off.instance.record("user", "hello");
    const on = setup();
    on.instance.record("assistant", "hello");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(off.generate).not.toHaveBeenCalled();
    expect(on.generate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("uses ordered complete session parts and only speaks the candidate after silence", async () => {
    const { instance, generate, speak } = setup();
    instance.record("user", "Which color?");
    instance.responseStarted(true);
    instance.record("assistant", "Blue or red.");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(generate).not.toHaveBeenCalled();
    instance.responseStopped();
    instance.observePlayback(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(generate).not.toHaveBeenCalled();
    instance.observePlayback(false);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(generate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(generate.mock.calls[0]?.[0]).toEqual([
      { role: "user", text: "Which color?" },
      { role: "assistant", text: "Blue or red." },
    ]);
    expect(speak).toHaveBeenCalledExactlyOnceWith("Want to revisit the color choice?");
  });
  it("consumes one attempt per user turn even when choosing silence, with shared cooldown", async () => {
    const { instance, generate, speak } = setup();
    generate.mockResolvedValue({ speak: false, text: "" });
    instance.record("user", "thinking");
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(generate).toHaveBeenCalledTimes(1);
    instance.record("user", "maybe blue");
    await vi.advanceTimersByTimeAsync(119_999);
    expect(generate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(speak).not.toHaveBeenCalled();
  });
  it.each([
    "speech",
    "dispose",
    "disallow",
  ])("discards a late candidate after %s", async (reason) => {
    const { instance, generate, speak, disallow } = setup();
    let resolve!: (candidate: FollowupCandidate) => void;
    generate.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    instance.record("user", "hello");
    await vi.advanceTimersByTimeAsync(60_000);
    if (reason === "speech") instance.userStarted();
    else if (reason === "dispose") instance.dispose();
    else disallow();
    resolve({ speak: true, text: "stale" });
    await Promise.resolve();
    expect(speak).not.toHaveBeenCalled();
    if (reason !== "disallow")
      expect((generate.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(true);
  });
  it("suppresses ongoing user speech and drops oversized parts instead of truncating", async () => {
    const { instance, generate } = setup();
    instance.record("user", "hello");
    instance.userStarted();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(generate).not.toHaveBeenCalled();
    instance.record("user", "あ".repeat(4001));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(generate).not.toHaveBeenCalled();
    instance.record("user", "fresh");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(generate.mock.calls[0]?.[0]).toEqual([{ role: "user", text: "fresh" }]);
  });
});

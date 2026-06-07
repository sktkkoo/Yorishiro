import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RuntimeAudioContextState = AudioContextState | "interrupted";

class FakeAudioContext {
  static initialState: RuntimeAudioContextState = "running";
  static resumeState: RuntimeAudioContextState = "running";
  static instances: FakeAudioContext[] = [];

  readonly sampleRate: number;
  state: RuntimeAudioContextState;
  readonly resume = vi.fn(async () => {
    this.state = FakeAudioContext.resumeState;
  });

  constructor(options?: AudioContextOptions) {
    this.sampleRate = options?.sampleRate ?? 0;
    this.state = FakeAudioContext.initialState;
    FakeAudioContext.instances.push(this);
  }
}

const loadAudioContextModule = async () => {
  return await import("./audio-context");
};

describe("audio-context", () => {
  beforeEach(() => {
    vi.resetModules();
    FakeAudioContext.initialState = "running";
    FakeAudioContext.resumeState = "running";
    FakeAudioContext.instances = [];
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("24 kHz の共有 AudioContext を作成する", async () => {
    const { getAudioContext } = await loadAudioContextModule();

    const ctx = getAudioContext() as unknown as FakeAudioContext;

    expect(ctx.sampleRate).toBe(24000);
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it("interrupted の AudioContext を resume して再生可能にする", async () => {
    FakeAudioContext.initialState = "interrupted";
    FakeAudioContext.resumeState = "running";
    const { ensureAudioContextRunning } = await loadAudioContextModule();

    const ctx = (await ensureAudioContextRunning()) as unknown as FakeAudioContext;

    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(ctx.state).toBe("running");
  });

  it("resume 後も interrupted の場合は WebAudio 再生に進ませない", async () => {
    FakeAudioContext.initialState = "interrupted";
    FakeAudioContext.resumeState = "interrupted";
    const { ensureAudioContextRunning } = await loadAudioContextModule();

    await expect(ensureAudioContextRunning()).rejects.toThrow(
      "AudioContext is not running after resume (state: interrupted)",
    );
  });

  it("closed になった共有 AudioContext は作り直す", async () => {
    const { ensureAudioContextRunning, getAudioContext } = await loadAudioContextModule();
    const first = getAudioContext() as unknown as FakeAudioContext;
    first.state = "closed";

    const second = (await ensureAudioContextRunning()) as unknown as FakeAudioContext;

    expect(second).not.toBe(first);
    expect(second.state).toBe("running");
    expect(FakeAudioContext.instances).toHaveLength(2);
  });
});

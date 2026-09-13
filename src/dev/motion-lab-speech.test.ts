import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LipSyncSource } from "../core/body";
import type { VoiceSpeechLifecycleCallbacks } from "../core/voice/voice-player";
import { MotionLabSpeech } from "./motion-lab-speech";

const mocked = vi.hoisted(() => {
  const players: FakePlayer[] = [];
  class FakePlayer {
    active = false;
    disposed = false;
    samples = 0;
    readonly id = `sample-${players.length}`;
    private resolve!: () => void;
    private readonly completion = new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
    constructor(
      _voice: unknown,
      _engine: unknown,
      readonly callbacks: VoiceSpeechLifecycleCallbacks,
    ) {
      players.push(this);
    }
    createVoiceAPI() {
      return {
        say: (text: string) => {
          this.callbacks.onPrepared(this.id, text);
          return { completion: this.completion };
        },
      };
    }
    start() {
      this.active = true;
      this.callbacks.onStarted(this.id, performance.now());
    }
    finish() {
      this.active = false;
      this.callbacks.onEnded(this.id, "completed");
      this.resolve();
    }
    dispose() {
      this.disposed = true;
      this.active = false;
      this.callbacks.onEnded(this.id, "disposed");
      this.resolve();
    }
    isMouthActive() {
      return this.active;
    }
    sampleMouth(out: { aa: number }) {
      out.aa = ++this.samples * 0.1;
      return out;
    }
  }
  return { players, FakePlayer, decode: vi.fn() };
});

vi.mock("../core/voice/voice-player", () => ({ VoicePlayer: mocked.FakePlayer }));
vi.mock("../core/voice/audio-context", () => ({
  ensureAudioContextRunning: async () => ({ decodeAudioData: mocked.decode }),
}));

function body() {
  return {
    setLipSyncSource: vi.fn<(source: LipSyncSource | null) => void>(),
    setMotionConversationPhase: vi.fn(),
    acquireSpeechStateExpression: vi.fn(() => ({ release: vi.fn() })),
    acquireSemanticMotion: vi.fn(() => null),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 15; i++) await Promise.resolve();
}

describe("MotionLabSpeech", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocked.players.length = 0;
    mocked.decode.mockResolvedValue({ duration: 10 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => ({ text: "そうですね。内容を一つずつ確認します。", voice: "Kyoko" }),
        arrayBuffer: async () => new ArrayBuffer(url.endsWith(".wav") ? 64 : 0),
      })),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("waits for real playback start, then sends the same cues and one mouth sample to both views", async () => {
    const left = body();
    const right = body();
    const speech = new MotionLabSpeech([left, right], vi.fn());
    expect(fetch).not.toHaveBeenCalled();
    const playback = speech.play();
    await flush();
    expect(mocked.decode).toHaveBeenCalledOnce();
    const player = mocked.players[0];
    expect(left.setMotionConversationPhase).toHaveBeenLastCalledWith("assistant-responding");
    await vi.advanceTimersByTimeAsync(500);
    expect(left.acquireSemanticMotion).not.toHaveBeenCalled();
    expect(right.acquireSpeechStateExpression).not.toHaveBeenCalled();
    player.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(left.setMotionConversationPhase).toHaveBeenLastCalledWith("assistant-speaking");
    expect(right.acquireSpeechStateExpression.mock.calls).toEqual(
      left.acquireSpeechStateExpression.mock.calls,
    );
    expect(right.acquireSemanticMotion).toHaveBeenCalledOnce();
    speech.sampleFrame();
    const sourceLeft = left.setLipSyncSource.mock.calls[0][0];
    const sourceRight = right.setLipSyncSource.mock.calls[0][0];
    expect(sourceLeft?.sampleMouth()).toEqual(sourceRight?.sampleMouth());
    expect(player.samples).toBe(1);
    player.finish();
    await playback;
    expect(left.setMotionConversationPhase).toHaveBeenLastCalledWith("idle");
    expect(left.acquireSpeechStateExpression.mock.results[0].value.release).toHaveBeenCalled();
    expect(speech.snapshot()).toMatchObject({ status: "idle", mouth: { aa: 0 } });
    speech.dispose();
  });

  it("disposes real playback and pending cues on stop, without a native stop call", async () => {
    const target = body();
    const speech = new MotionLabSpeech([target], vi.fn());
    const playback = speech.play();
    await flush();
    mocked.players[0].start();
    speech.stop();
    await playback;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocked.players[0].disposed).toBe(true);
    expect(target.acquireSemanticMotion).not.toHaveBeenCalled();
    expect(target.setMotionConversationPhase).toHaveBeenLastCalledWith("idle");
    expect(speech.snapshot()).toMatchObject({ status: "idle", mouth: { aa: 0 } });
    speech.dispose();
    expect(target.setLipSyncSource).toHaveBeenLastCalledWith(null);
  });

  it("does not start late file loading after cancellation or disposal", async () => {
    let resolveManifest!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveManifest = resolve;
        }),
    );
    const target = body();
    const speech = new MotionLabSpeech([target], vi.fn());
    const playback = speech.play();
    await flush();
    speech.dispose();
    resolveManifest(new Response(JSON.stringify({ text: "そうですね。" })));
    await playback;
    expect(mocked.players).toHaveLength(0);
    expect(target.setMotionConversationPhase).not.toHaveBeenCalled();
  });

  it("rejects a missing or undecodable sample before invoking the native-capable player", async () => {
    mocked.decode.mockRejectedValueOnce(new Error("bad WAV"));
    const speech = new MotionLabSpeech([body()], vi.fn());
    await speech.play();
    expect(mocked.players).toHaveLength(0);
    expect(speech.snapshot().status).toBe("error");
    speech.dispose();
  });
});

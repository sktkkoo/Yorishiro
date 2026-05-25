import { afterEach, describe, expect, it, vi } from "vitest";

const { mockInvoke, mockAudioContext, mockFetch } = vi.hoisted(() => {
  const createMockGainNode = () => {
    const gain = {
      value: 1,
      setValueAtTime: vi.fn((value: number) => {
        gain.value = value;
      }),
      linearRampToValueAtTime: vi.fn((value: number) => {
        gain.value = value;
      }),
    };
    return {
      connect: vi.fn(),
      gain,
    };
  };
  const mockGainNode = createMockGainNode();
  const mockAnalyserNode = {
    connect: vi.fn(() => mockGainNode),
    fftSize: 256,
    frequencyBinCount: 128,
    getByteFrequencyData: vi.fn((out: Uint8Array) => out.fill(0)),
    getByteTimeDomainData: vi.fn((out: Uint8Array) => out.fill(128)),
  };
  const mockSource = {
    buffer: null,
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null as (() => void) | null,
  };
  const mockAudioContext = {
    state: "running",
    resume: vi.fn(() => Promise.resolve()),
    createAnalyser: vi.fn(() => ({ ...mockAnalyserNode })),
    createGain: vi.fn(() => createMockGainNode()),
    createBufferSource: vi.fn(() => ({ ...mockSource })),
    createBuffer: vi.fn((numberOfChannels: number, length: number, sampleRate: number) => {
      const channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
      return {
        duration: length / sampleRate,
        length,
        numberOfChannels,
        sampleRate,
        getChannelData: vi.fn((channel: number) => channels[channel]),
      };
    }),
    decodeAudioData: vi.fn(async () => ({ duration: 0.02, length: 480, sampleRate: 24000 })),
    currentTime: 0,
    destination: {},
  };
  return {
    mockInvoke: vi.fn(() => Promise.resolve()),
    mockAudioContext,
    mockFetch: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("./audio-context", () => ({
  getAudioContext: () => mockAudioContext,
}));

// Node 環境に存在しないブラウザ API のスタブ
vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0));
vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
vi.stubGlobal("fetch", mockFetch);

import type { TtsEngine } from "./tts-engine";
import { VoicePlayer } from "./voice-player";

const flushPlaybackStart = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

// ---------------------------------------------------------------------------
// engine なし (従来の OS TTS フォールバック)
// ---------------------------------------------------------------------------

describe("VoicePlayer (engine なし — OS TTS フォールバック)", () => {
  afterEach(() => {
    mockInvoke.mockClear();
    mockAudioContext.createAnalyser.mockClear();
    mockAudioContext.createGain.mockClear();
    mockAudioContext.createBufferSource.mockClear();
    mockAudioContext.createBuffer.mockClear();
    mockAudioContext.decodeAudioData.mockReset();
    mockAudioContext.decodeAudioData.mockResolvedValue({
      duration: 0.02,
      length: 480,
      sampleRate: 24000,
    });
    mockFetch.mockReset();
  });

  it("say() は tts_speak を text 付きで invoke する", () => {
    const player = new VoicePlayer();
    const api = player.createVoiceAPI();
    api.say("こんにちは");
    expect(mockInvoke).toHaveBeenCalledWith("tts_speak", {
      text: "こんにちは",
      voice: null,
    });
  });

  it("say() はコンストラクタで指定した voice を渡す", () => {
    const player = new VoicePlayer("Kyoko");
    const api = player.createVoiceAPI();
    api.say("テスト");
    expect(mockInvoke).toHaveBeenCalledWith("tts_speak", {
      text: "テスト",
      voice: "Kyoko",
    });
  });

  it("say() は VoiceHandle を返す", () => {
    const player = new VoicePlayer();
    const api = player.createVoiceAPI();
    const handle = api.say("hello");
    expect(handle.startedAt).toBeGreaterThan(0);
    expect(handle.completion).toBeInstanceOf(Promise);
    expect(typeof handle.stop).toBe("function");
  });

  it("handle.stop() は tts_stop を invoke する", async () => {
    const player = new VoicePlayer();
    const api = player.createVoiceAPI();
    const handle = api.say("hello");
    await handle.stop();
    expect(mockInvoke).toHaveBeenCalledWith("tts_stop", {});
  });

  it("silence() は tts_stop を invoke する", () => {
    const player = new VoicePlayer();
    const api = player.createVoiceAPI();
    api.silence();
    expect(mockInvoke).toHaveBeenCalledWith("tts_stop", {});
  });

  it("play() は resolveClip の URL を fetch して Web Audio で再生する", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: vi.fn(async () => createMinimalWav()),
    });
    const player = new VoicePlayer();
    const api = player.createVoiceAPI({ resolveClip: () => "/voice.wav" });
    const handle = api.play("clip:greeting", { volume: 0.4 });

    expect(handle.startedAt).toBe(0);
    await flushPlaybackStart();

    expect(handle.startedAt).toBeGreaterThan(0);
    expect(mockFetch).toHaveBeenCalledWith("/voice.wav");
    expect(mockAudioContext.createBuffer).toHaveBeenCalledWith(1, 480, 24000);

    const outputGain = mockAudioContext.createGain.mock.results[1].value;
    expect(outputGain.gain.setValueAtTime).toHaveBeenCalledWith(0.4, mockAudioContext.currentTime);
  });

  it("play() は clip が解決できない場合 startedAt=0 のまま completion で失敗する", async () => {
    const player = new VoicePlayer();
    const api = player.createVoiceAPI();
    const handle = api.play("clip:missing");

    await expect(handle.completion).rejects.toThrow("Unable to resolve voice clip");
    expect(handle.startedAt).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("play() は fetch 失敗を completion で通知する", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      arrayBuffer: vi.fn(),
    });
    const player = new VoicePlayer();
    const api = player.createVoiceAPI({ resolveClip: () => "/missing.wav" });
    const handle = api.play("clip:missing");

    await expect(handle.completion).rejects.toThrow("HTTP 404");
    expect(handle.startedAt).toBe(0);
    consoleError.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// engine あり (Web Audio パイプライン)
// ---------------------------------------------------------------------------

function createMockEngine(): TtsEngine {
  return {
    name: "mock",
    synthesize: vi.fn(async () => createMinimalWav()),
  };
}

/** 最小限の WAV ヘッダ + 無音サンプル */
function createMinimalWav(): ArrayBuffer {
  const sampleRate = 24000;
  const numSamples = 480; // 20ms
  const dataSize = numSamples * 2; // 16-bit
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");

  // fmt chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample

  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);
  // samples は 0 (無音)

  return buffer;
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

describe("VoicePlayer (engine あり — Web Audio)", () => {
  afterEach(() => {
    mockInvoke.mockClear();
    mockAudioContext.createAnalyser.mockClear();
    mockAudioContext.createGain.mockClear();
    mockAudioContext.createBufferSource.mockClear();
    mockAudioContext.createBuffer.mockClear();
    mockAudioContext.decodeAudioData.mockReset();
    mockAudioContext.decodeAudioData.mockResolvedValue({
      duration: 0.02,
      length: 480,
      sampleRate: 24000,
    });
    mockFetch.mockReset();
  });

  it("say() は engine.synthesize を呼ぶ（tts_speak は呼ばない）", () => {
    const engine = createMockEngine();
    const player = new VoicePlayer("Kyoko", engine);
    const api = player.createVoiceAPI();
    api.say("テスト");

    expect(engine.synthesize).toHaveBeenCalledWith("テスト", "Kyoko");
    expect(mockInvoke).not.toHaveBeenCalledWith("tts_speak", expect.anything());
  });

  it("say() は VoiceHandle を返す", () => {
    const engine = createMockEngine();
    const player = new VoicePlayer(undefined, engine);
    const api = player.createVoiceAPI();
    const handle = api.say("hello");
    expect(handle.startedAt).toBeGreaterThan(0);
    expect(handle.completion).toBeInstanceOf(Promise);
    expect(typeof handle.stop).toBe("function");
  });

  it("setMouthCallback で口形素コールバックを設定できる", () => {
    const engine = createMockEngine();
    const player = new VoicePlayer(undefined, engine);
    const cb = vi.fn();
    player.setMouthCallback(cb);
    // コールバックは再生が始まるまで呼ばれないのでここでは 0 回
    expect(cb).not.toHaveBeenCalled();
  });

  it("sampleMouth() は engine なしでもゼロ値を返す", () => {
    const player = new VoicePlayer();
    const result = player.sampleMouth();
    expect(result).toEqual({ aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 });
  });

  it("dispose() でエラーなく呼べる", () => {
    const engine = createMockEngine();
    const player = new VoicePlayer(undefined, engine);
    expect(() => player.dispose()).not.toThrow();
  });

  it("PCM WAV は decodeAudioData を使わず直接 AudioBuffer に変換する", async () => {
    const engine = createMockEngine();
    const player = new VoicePlayer(undefined, engine);
    const api = player.createVoiceAPI();

    api.say("hello");
    await Promise.resolve();
    await Promise.resolve();

    expect(mockAudioContext.createBuffer).toHaveBeenCalledWith(1, 480, 24000);
    expect(mockAudioContext.decodeAudioData).not.toHaveBeenCalled();
  });

  it("say() は Web Audio 再生時に volume option を反映する", async () => {
    const engine = createMockEngine();
    const player = new VoicePlayer(undefined, engine);
    const api = player.createVoiceAPI();

    api.say("hello", { volume: 0.5 });
    await Promise.resolve();
    await Promise.resolve();

    const outputGain = mockAudioContext.createGain.mock.results[1].value;
    expect(outputGain.gain.setValueAtTime).toHaveBeenCalledWith(0.5, mockAudioContext.currentTime);
  });

  it("解析用 AnalyserNode は silent sink 経由で destination に接続される", async () => {
    const engine = createMockEngine();
    const player = new VoicePlayer(undefined, engine);
    const api = player.createVoiceAPI();

    api.say("hello");
    await Promise.resolve();
    await Promise.resolve();

    const analyser = mockAudioContext.createAnalyser.mock.results[0].value;
    const silentSink = mockAudioContext.createGain.mock.results[0].value;
    const outputGain = mockAudioContext.createGain.mock.results[1].value;
    const source = mockAudioContext.createBufferSource.mock.results[0].value;

    expect(silentSink.gain.value).toBe(0);
    expect(analyser.connect).toHaveBeenCalledWith(silentSink);
    expect(silentSink.connect).toHaveBeenCalledWith(mockAudioContext.destination);
    expect(outputGain.connect).toHaveBeenCalledWith(mockAudioContext.destination);
    expect(source.connect).toHaveBeenCalledWith(analyser);
    expect(source.connect).toHaveBeenCalledWith(outputGain);
  });

  it("Web Audio 再生に失敗した場合は OS TTS にフォールバックする", async () => {
    mockAudioContext.decodeAudioData.mockRejectedValueOnce(
      new DOMException("Decoding failed", "EncodingError"),
    );
    const engine: TtsEngine = {
      name: "mock",
      synthesize: vi.fn(async () => new ArrayBuffer(4)),
    };
    const player = new VoicePlayer("Kyoko", engine);
    const api = player.createVoiceAPI();
    const handle = api.say("hello");

    await handle.completion;

    expect(mockInvoke).toHaveBeenCalledWith("tts_speak", {
      text: "hello",
      voice: "Kyoko",
    });
  });

  it("OS TTS フォールバック中は mouth 値を返さない", async () => {
    mockAudioContext.decodeAudioData.mockRejectedValueOnce(
      new DOMException("Decoding failed", "EncodingError"),
    );
    const engine: TtsEngine = {
      name: "mock",
      synthesize: vi.fn(async () => new ArrayBuffer(4)),
    };
    const player = new VoicePlayer("Kyoko", engine);
    const api = player.createVoiceAPI();
    const handle = api.say("あ");

    await handle.completion;

    const mouth = player.sampleMouth();
    expect(mouth).toEqual({ aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 });
  });

  it("Web Audio 再生中はテキスト推定ではなく音声解析を優先する", async () => {
    mockAudioContext.createAnalyser.mockReturnValueOnce({
      connect: vi.fn(),
      fftSize: 256,
      frequencyBinCount: 128,
      getByteFrequencyData: vi.fn((out: Uint8Array) => out.fill(0)),
      getByteTimeDomainData: vi.fn((out: Uint8Array) => {
        for (let i = 0; i < out.length; i++) out[i] = i % 2 === 0 ? 96 : 160;
        return out;
      }),
    });
    const engine = createMockEngine();
    const player = new VoicePlayer(undefined, engine);
    const api = player.createVoiceAPI();

    api.say("い");
    await Promise.resolve();
    await Promise.resolve();

    const mouth = player.sampleMouth();
    expect(mouth.aa).toBeGreaterThan(0);
    expect(mouth.ih).toBe(0);
    expect(mockAudioContext.decodeAudioData).not.toHaveBeenCalled();
  });

  it("未開始の play handle を stop しても既存の say 再生は止めない", async () => {
    const engine = createMockEngine();
    const player = new VoicePlayer(undefined, engine);
    const api = player.createVoiceAPI();
    api.say("hello");
    await Promise.resolve();
    await Promise.resolve();
    const saySource = mockAudioContext.createBufferSource.mock.results[0].value;

    let resolveClip: (value: string) => void = () => {};
    const clipHandle = api.play("clip:late", {
      volume: 0.5,
    });
    const scopedApi = player.createVoiceAPI({
      resolveClip: () =>
        new Promise<string>((resolve) => {
          resolveClip = resolve;
        }),
    });
    const lateHandle = scopedApi.play("clip:late");

    await Promise.resolve();
    await clipHandle.stop();
    await lateHandle.stop();
    resolveClip("/late.wav");
    await lateHandle.completion;

    expect(saySource.stop).not.toHaveBeenCalled();
  });

  it("古い fade timer は新しい clip の volume を 1 に戻さない", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: vi.fn(async () => createMinimalWav()),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: vi.fn(async () => createMinimalWav()),
      });
    const player = new VoicePlayer();
    const api = player.createVoiceAPI({ resolveClip: () => "/voice.wav" });
    const first = api.play("clip:first", { volume: 0.3 });
    await flushPlaybackStart();
    await first.stop();

    api.play("clip:second", { volume: 0.3 });
    await flushPlaybackStart();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const outputGain = mockAudioContext.createGain.mock.results[1].value;
    expect(outputGain.gain.value).toBe(0.3);
  });
});

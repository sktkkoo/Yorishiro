import { afterEach, describe, expect, it, vi } from "vitest";

const { mockInvoke, mockAudioContext } = vi.hoisted(() => {
  const mockGainNode = {
    connect: vi.fn(),
    gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
  };
  const mockAnalyserNode = {
    connect: vi.fn(() => mockGainNode),
    fftSize: 256,
    frequencyBinCount: 128,
    getByteFrequencyData: vi.fn(),
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
    createGain: vi.fn(() => ({ ...mockGainNode })),
    createBufferSource: vi.fn(() => ({ ...mockSource })),
    decodeAudioData: vi.fn(async () => ({ duration: 0.02, length: 480, sampleRate: 24000 })),
    currentTime: 0,
    destination: {},
  };
  return {
    mockInvoke: vi.fn(() => Promise.resolve()),
    mockAudioContext,
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("./audio-context", () => ({
  getAudioContext: () => mockAudioContext,
}));

// Node 環境に存在しないブラウザ API のスタブ
vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0));
vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));

import type { TtsEngine } from "./tts-engine";
import { VoicePlayer } from "./voice-player";

// ---------------------------------------------------------------------------
// engine なし (従来の OS TTS フォールバック)
// ---------------------------------------------------------------------------

describe("VoicePlayer (engine なし — OS TTS フォールバック)", () => {
  afterEach(() => {
    mockInvoke.mockClear();
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

  it("play() はスタブハンドルを返す（post-MVP）", () => {
    const player = new VoicePlayer();
    const api = player.createVoiceAPI();
    const handle = api.play("clip:greeting");
    expect(handle.startedAt).toBe(0);
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
});

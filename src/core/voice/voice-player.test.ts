import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBodyStateExpressionAdapter } from "../../runtime/agent-state-expression/body-adapter";
import { createVoiceStateExpressionBridge } from "../../runtime/agent-state-expression/voice-state-expression-bridge";
import { AnimationPlayer, Body } from "../body";
import { DEFAULT_CHARACTER_MOTION_PROFILE } from "../body/motion-profile";

const { mockInvoke, mockAudioContext, mockFetch, mockEnsureAudioContextRunning, detachAudioData } =
  vi.hoisted(() => {
    const createMockGainNode = () => {
      const gain = {
        value: 1,
        cancelScheduledValues: vi.fn(),
        setValueAtTime: vi.fn((value: number) => {
          gain.value = value;
        }),
        linearRampToValueAtTime: vi.fn((value: number) => {
          gain.value = value;
        }),
      };
      return {
        connect: vi.fn(),
        disconnect: vi.fn(),
        gain,
      };
    };
    const mockGainNode = createMockGainNode();
    const mockAnalyserNode = {
      connect: vi.fn(() => mockGainNode),
      disconnect: vi.fn(),
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
    // 実 decodeAudioData と同じく入力 ArrayBuffer を detach する。
    // fallback 経路が detached buffer を掴む regression を検出するための模倣。
    const detachAudioData = (audioData: ArrayBuffer): void => {
      structuredClone(audioData, { transfer: [audioData] });
    };
    const mockAudioContext = {
      state: "running",
      resume: vi.fn(() => Promise.resolve()),
      createAnalyser: vi.fn(() => ({ ...mockAnalyserNode })),
      createGain: vi.fn(() => createMockGainNode()),
      createBufferSource: vi.fn(() => ({
        ...mockSource,
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      })),
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
      decodeAudioData: vi.fn(async (audioData: ArrayBuffer) => {
        detachAudioData(audioData);
        return { duration: 0.02, length: 480, sampleRate: 24000 };
      }),
      currentTime: 0,
      destination: {},
    };
    const mockEnsureAudioContextRunning = vi.fn(async () => mockAudioContext);
    return {
      mockInvoke: vi.fn((_command?: string, _args?: Record<string, unknown>) => Promise.resolve()),
      mockAudioContext,
      mockFetch: vi.fn(),
      mockEnsureAudioContextRunning,
      detachAudioData,
    };
  });

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
  Channel: class {
    onmessage: ((data: ArrayBuffer) => void) | null = null;
  },
}));
vi.mock("./audio-context", () => ({
  ensureAudioContextRunning: mockEnsureAudioContextRunning,
  getAudioContext: () => mockAudioContext,
}));

// Node 環境に存在しないブラウザ API のスタブ
vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0));
vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
vi.stubGlobal("fetch", mockFetch);

import { SayTtsEngine, type TtsEngine } from "./tts-engine";
import { VoicePlayer } from "./voice-player";
import { getVoiceVolumeStore } from "./voice-volume-store";

const flushPlaybackStart = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function speechLifecycle() {
  return { onPrepared: vi.fn(), onStarted: vi.fn(), onEnded: vi.fn(), onInvalidated: vi.fn() };
}

function groundedSpeechLifecycle() {
  const phases: string[] = [];
  const release = vi.fn();
  const bridge = createVoiceStateExpressionBridge({
    onCue: vi.fn(),
    onRelease: release,
    onConversationPhaseChange: (phase) => phases.push(phase),
  });
  return {
    phases,
    release,
    lifecycle: {
      onPrepared: vi.fn(bridge.onPrepared),
      onStarted: vi.fn(bridge.onStarted),
      onEnded: vi.fn(bridge.onEnded),
      onInvalidated: vi.fn(bridge.onInvalidated),
    },
  };
}

afterEach(() => {
  getVoiceVolumeStore().set(1);
});

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
    mockAudioContext.decodeAudioData.mockImplementation(async (audioData: ArrayBuffer) => {
      detachAudioData(audioData);
      return { duration: 0.02, length: 480, sampleRate: 24000 };
    });
    mockFetch.mockReset();
    mockEnsureAudioContextRunning.mockReset();
    mockEnsureAudioContextRunning.mockResolvedValue(mockAudioContext);
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

  it("does not invent semantic playback timing for the unclocked native fallback", async () => {
    const lifecycle = speechLifecycle();
    const player = new VoicePlayer("Kyoko", undefined, lifecycle);
    await player.createVoiceAPI().say("はい。").completion;
    expect(lifecycle.onPrepared).not.toHaveBeenCalled();
    expect(lifecycle.onStarted).not.toHaveBeenCalled();
    expect(lifecycle.onEnded).not.toHaveBeenCalled();
    player.dispose();
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

  it("voice volume が 0 のとき OS TTS fallback を開始しない", async () => {
    getVoiceVolumeStore().set(0);
    const player = new VoicePlayer();

    const handle = player.createVoiceAPI().say("muted");
    await handle.completion;

    expect(mockInvoke).not.toHaveBeenCalledWith("tts_speak", expect.anything());
    player.dispose();
  });

  it("OS TTS fallback の再生中に mute すると即時停止する", async () => {
    const player = new VoicePlayer();
    const handle = player.createVoiceAPI().say("speaking");
    // Native tts_speak resolves after spawning the OS process, while speech may continue.
    await handle.completion;
    mockInvoke.mockClear();

    getVoiceVolumeStore().set(0);

    expect(mockInvoke).toHaveBeenCalledWith("tts_stop", {});
    player.dispose();
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
    expect(mockFetch).toHaveBeenCalledWith("/voice.wav", { signal: expect.any(AbortSignal) });
    expect(mockAudioContext.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(mockAudioContext.createBuffer).not.toHaveBeenCalled();

    const outputGain = mockAudioContext.createGain.mock.results[1].value;
    const masterGain = mockAudioContext.createGain.mock.results[2].value;
    expect(outputGain.gain.setValueAtTime).toHaveBeenCalledWith(0.4, mockAudioContext.currentTime);
    expect(outputGain.connect).toHaveBeenCalledWith(masterGain);
    expect(masterGain.connect).toHaveBeenCalledWith(mockAudioContext.destination);

    getVoiceVolumeStore().set(0.25);
    expect(masterGain.gain.setValueAtTime).toHaveBeenCalledWith(0.25, mockAudioContext.currentTime);
    mockAudioContext.createBufferSource.mock.results[0].value.onended?.();
    player.dispose();
  });

  it("play() は clip が解決できない場合 startedAt=0 のまま completion で失敗する", async () => {
    const player = new VoicePlayer();
    const api = player.createVoiceAPI();
    const handle = api.play("clip:missing");

    await expect(handle.completion).rejects.toThrow("Unable to resolve voice clip");
    expect(handle.startedAt).toBe(0);
    expect(handle.cancellationReason).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("再生無効中の play() は typed cancellation として完了する", async () => {
    const player = new VoicePlayer();
    player.setPlaybackEnabled(false);

    const handle = player.createVoiceAPI().play("clip:missing");

    await expect(handle.completion).resolves.toBeUndefined();
    expect(handle.startedAt).toBe(0);
    expect(handle.cancellationReason).toBe("playback-disabled");
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

/** 最小限の WAV ヘッダ + mono PCM サンプル */
function createMinimalWav(sampleValue = 0, numSamples = 480): ArrayBuffer {
  const sampleRate = 24000;
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
  for (let i = 0; i < numSamples; i++) {
    view.setInt16(44 + i * 2, sampleValue, true);
  }

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
    mockAudioContext.decodeAudioData.mockImplementation(async (audioData: ArrayBuffer) => {
      detachAudioData(audioData);
      return { duration: 0.02, length: 480, sampleRate: 24000 };
    });
    mockFetch.mockReset();
    mockEnsureAudioContextRunning.mockReset();
    mockEnsureAudioContextRunning.mockResolvedValue(mockAudioContext);
  });

  it("say() は engine.synthesize を呼ぶ（tts_speak は呼ばない）", () => {
    const engine = createMockEngine();
    const player = new VoicePlayer("Kyoko", engine);
    const api = player.createVoiceAPI();
    api.say("テスト");

    expect(engine.synthesize).toHaveBeenCalledWith("テスト", "Kyoko");
    expect(mockInvoke).not.toHaveBeenCalledWith("tts_speak", expect.anything());
  });

  it("connects the real local SayTtsEngine text to semantic timing only after source.start", async () => {
    const lifecycle = speechLifecycle();
    let output: { onmessage: ((data: ArrayBuffer) => void) | null } | undefined;
    mockInvoke.mockImplementationOnce(async (command, args) => {
      expect(command).toBe("tts_synthesize");
      expect(args?.text).toBe("はい。");
      output = args?.onOutput as typeof output;
    });
    const player = new VoicePlayer("Kyoko", new SayTtsEngine(), lifecycle);
    const handle = player.createVoiceAPI().say("はい。");
    const utteranceId = lifecycle.onPrepared.mock.calls[0][0];
    expect(lifecycle.onPrepared).toHaveBeenCalledWith(utteranceId, "はい。");
    expect(lifecycle.onStarted).not.toHaveBeenCalled();
    output?.onmessage?.(createMinimalWav());
    await flushPlaybackStart();
    const source = mockAudioContext.createBufferSource.mock.results[0].value;
    expect(lifecycle.onStarted).toHaveBeenCalledWith(utteranceId, expect.any(Number));
    expect(lifecycle.onStarted.mock.invocationCallOrder[0]).toBeGreaterThan(
      source.start.mock.invocationCallOrder[0],
    );
    source.onended?.();
    await handle.completion;
    expect(lifecycle.onEnded).toHaveBeenCalledWith(utteranceId, "completed");
    expect(mockInvoke).not.toHaveBeenCalledWith("tts_speak", expect.anything());
    player.dispose();
  });

  it.each([
    "silence",
    "dispose",
    "disable",
  ] as const)("invalidates only the completed speech recovery on %s after its audio operation is gone", async (action) => {
    const { lifecycle, release, phases } = groundedSpeechLifecycle();
    const player = new VoicePlayer("Kyoko", createMockEngine(), lifecycle);
    const api = player.createVoiceAPI();
    const handle = api.say("成功しましたね。");
    await flushPlaybackStart();
    const id = lifecycle.onPrepared.mock.calls[0][0];
    const source = mockAudioContext.createBufferSource.mock.results[0].value;
    source.onended?.();
    await handle.completion;
    release.mockClear();
    const phaseCount = phases.length;
    if (action === "silence") api.silence();
    else if (action === "dispose") player.dispose();
    else player.setPlaybackEnabled(false);
    expect(release).toHaveBeenCalledExactlyOnceWith(id, "cancelled");
    expect(phases).toHaveLength(phaseCount);
    expect(lifecycle.onEnded).toHaveBeenCalledExactlyOnceWith(id, "completed");
    player.dispose();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    "silence",
    "dispose",
    "disable",
  ] as const)("cannot announce a completed recovery after %s wins between audio completion microtasks", async (action) => {
    for (const depth of [2, 3, 4]) {
      const { lifecycle, release, phases } = groundedSpeechLifecycle();
      const player = new VoicePlayer("Kyoko", createMockEngine(), lifecycle);
      const api = player.createVoiceAPI();
      const handle = api.say("成功しましたね。");
      await flushPlaybackStart();
      const sources = mockAudioContext.createBufferSource.mock.results;
      sources[sources.length - 1].value.onended?.();
      let boundary = Promise.resolve();
      for (let index = 0; index < depth; index++) boundary = boundary.then(() => {});
      let phaseCount = 0;
      await boundary.then(() => {
        if (action === "silence") api.silence();
        else if (action === "dispose") player.dispose();
        else player.setPlaybackEnabled(false);
        phaseCount = phases.length;
      });
      await handle.completion;
      expect(release.mock.lastCall?.[1]).toBe("cancelled");
      expect(phases).toHaveLength(phaseCount);
      player.dispose();
    }
  });

  it("scopes a completed voice handle's stop to its own recovery, including after a newer voice completes", async () => {
    const { lifecycle, release, phases } = groundedSpeechLifecycle();
    const player = new VoicePlayer("Kyoko", createMockEngine(), lifecycle);
    const api = player.createVoiceAPI();
    const first = api.say("成功しましたね。");
    await flushPlaybackStart();
    mockAudioContext.createBufferSource.mock.results[0].value.onended?.();
    await first.completion;
    const second = api.say("まだ分かりません。");
    await flushPlaybackStart();
    mockAudioContext.createBufferSource.mock.results[1].value.onended?.();
    await second.completion;
    const oldId = lifecycle.onPrepared.mock.calls[0][0];
    const newId = lifecycle.onPrepared.mock.calls[1][0];
    release.mockClear();
    const phaseCount = phases.length;
    await first.stop();
    expect(lifecycle.onInvalidated).toHaveBeenLastCalledWith(oldId);
    expect(release).not.toHaveBeenCalled();
    await second.stop();
    expect(release).toHaveBeenCalledExactlyOnceWith(newId, "cancelled");
    await second.stop();
    expect(release).toHaveBeenCalledOnce();
    expect(phases).toHaveLength(phaseCount);
    player.dispose();
  });

  it("releases a completed semantic recovery when non-speech audio actually starts", async () => {
    const { lifecycle, release } = groundedSpeechLifecycle();
    const player = new VoicePlayer("Kyoko", createMockEngine(), lifecycle);
    const api = player.createVoiceAPI();
    const first = api.say("成功しましたね。");
    await flushPlaybackStart();
    mockAudioContext.createBufferSource.mock.results[0].value.onended?.();
    await first.completion;
    release.mockClear();
    let ready!: () => void;
    const loading = new Promise<void>((resolve) => {
      ready = resolve;
    });
    mockFetch.mockImplementationOnce(async () => {
      await loading;
      return { ok: true, arrayBuffer: async () => createMinimalWav() };
    });
    const clip = api.play("https://example.test/voice.wav");
    await flushPlaybackStart();
    expect(release).not.toHaveBeenCalled();
    ready();
    await flushPlaybackStart();
    expect(release).toHaveBeenCalledExactlyOnceWith(
      lifecycle.onPrepared.mock.calls[0][0],
      "cancelled",
    );
    await clip.stop();
    player.dispose();
  });

  it("supersedes pending synthesis so a late old result cannot start sound or gestures", async () => {
    const lifecycle = speechLifecycle();
    let resolveOld!: (data: ArrayBuffer) => void;
    const engine: TtsEngine = {
      name: "local",
      synthesize: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<ArrayBuffer>((resolve) => {
              resolveOld = resolve;
            }),
        )
        .mockResolvedValueOnce(createMinimalWav()),
    };
    const player = new VoicePlayer(undefined, engine, lifecycle);
    const old = player.createVoiceAPI().say("old");
    const oldId = lifecycle.onPrepared.mock.calls[0][0];
    const next = player.createVoiceAPI().say("はい。");
    const nextId = lifecycle.onPrepared.mock.calls[1][0];
    await old.completion;
    await flushPlaybackStart();
    expect(old.cancellationReason).toBe("stopped");
    expect(lifecycle.onEnded).toHaveBeenCalledWith(oldId, "stopped");
    expect(lifecycle.onStarted).toHaveBeenCalledTimes(1);
    expect(lifecycle.onStarted).toHaveBeenCalledWith(nextId, expect.any(Number));
    resolveOld(createMinimalWav());
    await flushPlaybackStart();
    expect(mockAudioContext.createBufferSource).toHaveBeenCalledTimes(1);
    await next.stop();
    player.dispose();
  });

  it("keeps the same Body conversation motion across an immediate audio replacement", async () => {
    const bones = new Map<VRMHumanBoneName, THREE.Object3D>();
    const scene = new THREE.Object3D();
    const vrm = {
      scene,
      meta: { metaVersion: "1" },
      humanoid: {
        resetNormalizedPose: () => {},
        getNormalizedBoneNode: (name: VRMHumanBoneName) => {
          let bone = bones.get(name);
          if (!bone) {
            bone = new THREE.Object3D();
            bone.name = name;
            scene.add(bone);
            bones.set(name, bone);
          }
          return bone;
        },
      },
      expressionManager: { getExpression: () => null, setValue: () => {}, update: () => {} },
      lookAt: { yaw: 0, pitch: 0, applier: { applyYawPitch: () => {} } },
      update: () => {},
    } as unknown as VRM;
    let completeMotion = () => {};
    const motion = {
      id: 1,
      completion: new Promise<void>((resolve) => {
        completeMotion = resolve;
      }),
      get stopped() {
        return this.completion;
      },
      setWeight: vi.fn(),
      stop: vi.fn(async () => completeMotion()),
      cancel: vi.fn(() => completeMotion()),
    };
    const preload = vi
      .spyOn(AnimationPlayer.prototype, "preload")
      .mockImplementation(async (_ref, opts) => opts?.mask !== "lower-body");
    const evaluate = vi
      .spyOn(AnimationPlayer.prototype, "evaluateTransition")
      .mockReturnValue({ cost: 0, startTimeSec: 0 });
    const play = vi.spyOn(AnimationPlayer.prototype, "play").mockResolvedValue(motion);
    const body = new Body(
      vrm,
      undefined,
      {
        isClaimed: () => false,
        claim: () => ({ dispose() {} }),
        releaseAll() {},
      },
      { modelSha256: DEFAULT_CHARACTER_MOTION_PROFILE.modelSha256 },
    );
    const phases: string[] = [];
    const adapter = createBodyStateExpressionAdapter(() => body);
    const bridge = createVoiceStateExpressionBridge({
      ...adapter,
      onConversationPhaseChange: (phase) => {
        phases.push(phase);
        adapter.onConversationPhaseChange?.(phase);
      },
    });
    const player = new VoicePlayer(undefined, createMockEngine(), bridge);
    try {
      await body.prepareMotionLibrary();
      const api = player.createVoiceAPI();
      api.say("設定画面には三つの項目があります。");
      await flushPlaybackStart();
      for (let frame = 0; frame < 80; frame++) body.update(1 / 60, frame / 60);
      await flushPlaybackStart();
      expect(play).toHaveBeenCalledOnce();
      expect(play.mock.calls[0][1]?.loop).toBe(true);
      const source = mockAudioContext.createBufferSource.mock.results[0].value;
      phases.length = 0;

      api.say("左側の一覧から対象を選択できます。");
      await flushPlaybackStart();

      expect(source.stop).toHaveBeenCalledOnce();
      expect(phases).toEqual(["assistant-speaking"]);
      expect(motion.stop).not.toHaveBeenCalled();
      expect(play).toHaveBeenCalledOnce();
      expect(body.getMotionSnapshot().active?.priority).toBe("idle-fidget");

      const nextSource = mockAudioContext.createBufferSource.mock.results[1].value;
      nextSource.onended?.();
      await flushPlaybackStart();
      expect(phases).toEqual(["assistant-speaking", "idle"]);
      expect(motion.stop).toHaveBeenCalledExactlyOnceWith(650);
    } finally {
      player.dispose();
      body.dispose();
      play.mockRestore();
      evaluate.mockRestore();
      preload.mockRestore();
    }
  });

  it("releases old speech ownership when its replacement is a non-speech voice clip", async () => {
    const { lifecycle, phases, release } = groundedSpeechLifecycle();
    const player = new VoicePlayer(undefined, createMockEngine(), lifecycle);
    try {
      const api = player.createVoiceAPI({ resolveClip: () => "/non-speech.wav" });
      api.say("設定画面には三つの項目があります。");
      await flushPlaybackStart();
      const oldId = lifecycle.onPrepared.mock.calls[0][0];
      phases.length = 0;
      mockFetch.mockResolvedValueOnce({ ok: true, arrayBuffer: async () => createMinimalWav() });
      const clip = api.play("clip:notification");
      await flushPlaybackStart();

      expect(
        mockAudioContext.createBufferSource.mock.results[1].value.start,
      ).toHaveBeenCalledOnce();
      expect(phases).toEqual(["idle"]);
      expect(release).toHaveBeenCalledExactlyOnceWith(oldId, "cancelled");
      expect(lifecycle.onStarted).toHaveBeenCalledOnce();
      await clip.stop();
    } finally {
      player.dispose();
    }
  });

  it("preserves a genuine speech gap while the replacement is still synthesizing", async () => {
    const { lifecycle, phases, release } = groundedSpeechLifecycle();
    let resolveNext = (_audio: ArrayBuffer) => {};
    const engine: TtsEngine = {
      name: "deferred replacement",
      synthesize: vi
        .fn()
        .mockResolvedValueOnce(createMinimalWav())
        .mockImplementationOnce(
          () =>
            new Promise<ArrayBuffer>((resolve) => {
              resolveNext = resolve;
            }),
        ),
    };
    const player = new VoicePlayer(undefined, engine, lifecycle);
    try {
      const api = player.createVoiceAPI();
      api.say("設定画面には三つの項目があります。");
      await flushPlaybackStart();
      const oldId = lifecycle.onPrepared.mock.calls[0][0];
      const next = api.say("左側の一覧から対象を選択できます。");
      phases.length = 0;
      mockAudioContext.createBufferSource.mock.results[0].value.onended?.();
      await flushPlaybackStart();

      expect(phases).toEqual(["assistant-responding"]);
      expect(release).toHaveBeenCalledExactlyOnceWith(oldId, "completed");
      expect(lifecycle.onStarted).toHaveBeenCalledOnce();
      resolveNext(createMinimalWav());
      await flushPlaybackStart();
      expect(phases).toEqual(["assistant-responding", "assistant-speaking"]);
      await next.stop();
      expect(phases[phases.length - 1]).toBe("idle");
    } finally {
      player.dispose();
    }
  });

  it("ends both speech owners without a false started event when replacement source.start fails", async () => {
    const { lifecycle, phases, release } = groundedSpeechLifecycle();
    const player = new VoicePlayer(undefined, createMockEngine(), lifecycle);
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const api = player.createVoiceAPI();
      const old = api.say("設定画面には三つの項目があります。");
      await flushPlaybackStart();
      const oldId = lifecycle.onPrepared.mock.calls[0][0];
      const createSource = mockAudioContext.createBufferSource.getMockImplementation();
      if (!createSource) throw new Error("missing audio source fixture");
      mockAudioContext.createBufferSource.mockImplementationOnce(() => ({
        ...createSource(),
        start: vi.fn(() => {
          throw new Error("source start failed");
        }),
      }));
      phases.length = 0;
      const next = api.say("左側の一覧から対象を選択できます。");
      await next.completion;
      await old.completion;

      expect(lifecycle.onStarted).toHaveBeenCalledOnce();
      expect(lifecycle.onEnded).toHaveBeenCalledWith(oldId, "stopped");
      expect(lifecycle.onEnded).toHaveBeenCalledWith(
        lifecycle.onPrepared.mock.calls[1][0],
        "unclocked",
      );
      expect(release).toHaveBeenCalledExactlyOnceWith(oldId, "cancelled");
      expect(phases).toEqual(["assistant-responding", "idle"]);
      expect(old.cancellationReason).toBe("stopped");
    } finally {
      player.dispose();
      warning.mockRestore();
    }
  });

  it("keeps audible speech owned until the replacement audio is ready", async () => {
    const lifecycle = speechLifecycle();
    let resolveNext!: (data: ArrayBuffer) => void;
    const engine: TtsEngine = {
      name: "local",
      synthesize: vi
        .fn()
        .mockResolvedValueOnce(createMinimalWav())
        .mockImplementationOnce(
          () =>
            new Promise<ArrayBuffer>((resolve) => {
              resolveNext = resolve;
            }),
        ),
    };
    const player = new VoicePlayer(undefined, engine, lifecycle);
    const first = player.createVoiceAPI().say("first");
    const firstId = lifecycle.onPrepared.mock.calls[0][0];
    await flushPlaybackStart();
    const firstSource = mockAudioContext.createBufferSource.mock.results[0].value;
    const next = player.createVoiceAPI().say("next");
    expect(firstSource.stop).not.toHaveBeenCalled();
    expect(lifecycle.onEnded).not.toHaveBeenCalled();
    resolveNext(createMinimalWav());
    await flushPlaybackStart();
    await first.completion;
    expect(firstSource.stop).toHaveBeenCalledOnce();
    expect(lifecycle.onEnded).toHaveBeenCalledWith(firstId, "stopped");
    expect(lifecycle.onStarted).toHaveBeenCalledTimes(2);
    firstSource.onended?.();
    await flushPlaybackStart();
    expect(lifecycle.onEnded.mock.calls.filter(([id]) => id === firstId)).toHaveLength(1);
    await next.stop();
    player.dispose();
  });

  it.each([
    "stop",
    "disable",
    "dispose",
  ] as const)("%s releases pending semantic cues and rejects a late synthesis result", async (action) => {
    const lifecycle = speechLifecycle();
    let resolveSynth!: (data: ArrayBuffer) => void;
    const engine: TtsEngine = {
      name: "local",
      synthesize: () =>
        new Promise<ArrayBuffer>((resolve) => {
          resolveSynth = resolve;
        }),
    };
    const player = new VoicePlayer(undefined, engine, lifecycle);
    const handle = player.createVoiceAPI().say("はい。");
    const id = lifecycle.onPrepared.mock.calls[0][0];
    if (action === "stop") await handle.stop();
    else if (action === "disable") player.setPlaybackEnabled(false);
    else player.dispose();
    await handle.completion;
    expect(lifecycle.onEnded).toHaveBeenCalledWith(
      id,
      action === "stop" ? "stopped" : action === "disable" ? "playback-disabled" : "disposed",
    );
    resolveSynth(createMinimalWav());
    await flushPlaybackStart();
    expect(lifecycle.onStarted).not.toHaveBeenCalled();
    expect(lifecycle.onEnded).toHaveBeenCalledOnce();
    if (action !== "dispose") player.dispose();
  });

  it("drops semantic cues when local synthesis falls back to unclocked native speech", async () => {
    const lifecycle = speechLifecycle();
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    const player = new VoicePlayer(
      "Kyoko",
      {
        name: "failed-local",
        synthesize: async () => {
          throw new Error("synthesis failed");
        },
      },
      lifecycle,
    );
    try {
      await player.createVoiceAPI().say("はい。").completion;
      const id = lifecycle.onPrepared.mock.calls[0][0];
      expect(lifecycle.onStarted).not.toHaveBeenCalled();
      expect(lifecycle.onEnded).toHaveBeenCalledExactlyOnceWith(id, "unclocked");
      expect(mockInvoke).toHaveBeenCalledWith("tts_speak", { text: "はい。", voice: "Kyoko" });
    } finally {
      warning.mockRestore();
      player.dispose();
    }
  });

  it("synchronously clears local speech ownership before realtime takeover and never clears it twice", async () => {
    const lifecycle = speechLifecycle();
    const player = new VoicePlayer(undefined, createMockEngine(), lifecycle);
    const handle = player.createVoiceAPI().say("はい。");
    await flushPlaybackStart();
    const id = lifecycle.onPrepared.mock.calls[0][0];
    player.setPlaybackEnabled(false);
    // useCodexRealtime awaits this ownership claim before client.start().
    expect(lifecycle.onEnded).toHaveBeenCalledExactlyOnceWith(id, "playback-disabled");
    await handle.completion;
    expect(lifecycle.onEnded).toHaveBeenCalledOnce();
    player.dispose();
  });

  it("does not replay speech through OS fallback when the avatar callback throws", async () => {
    const lifecycle = speechLifecycle();
    lifecycle.onStarted.mockImplementation(() => {
      throw new Error("avatar unavailable");
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const player = new VoicePlayer(undefined, createMockEngine(), lifecycle);
    try {
      const handle = player.createVoiceAPI().say("はい。");
      await flushPlaybackStart();
      expect(mockInvoke).not.toHaveBeenCalledWith("tts_speak", expect.anything());
      mockAudioContext.createBufferSource.mock.results[0].value.onended?.();
      await handle.completion;
    } finally {
      warning.mockRestore();
      player.dispose();
    }
  });

  it("再生無効中は新しい発話を合成しない", async () => {
    const engine = createMockEngine();
    const player = new VoicePlayer(undefined, engine);
    player.setPlaybackEnabled(false);

    const handle = player.createVoiceAPI().say("スキップ");

    await expect(handle.completion).resolves.toBeUndefined();
    expect(engine.synthesize).not.toHaveBeenCalled();
    expect(player.isPlaybackEnabled()).toBe(false);
  });

  it("Rust-issued owner ID と current generation が一致する request だけを許可する", () => {
    const player = new VoicePlayer();
    player.setPlaybackOwnerId("rust-owner-1");
    const initial = player.getPlaybackOwnershipState();

    expect(
      player.canPlayRequest({
        ownerId: "rust-owner-1",
        generation: initial.generation,
        fallbackPlaybackEnabled: true,
      }),
    ).toBe(true);

    player.setPlaybackEnabled(false);
    player.setPlaybackEnabled(true);

    expect(
      player.canPlayRequest({
        ownerId: "rust-owner-1",
        generation: initial.generation,
        fallbackPlaybackEnabled: true,
      }),
    ).toBe(false);
    expect(
      player.canPlayRequest({
        ownerId: "previous-rust-owner",
        generation: 2,
        fallbackPlaybackEnabled: true,
      }),
    ).toBe(false);
    expect(
      player.canPlayRequest({
        ownerId: "rust-owner-1",
        generation: 2,
        fallbackPlaybackEnabled: true,
      }),
    ).toBe(true);
  });

  it("playback owner identity does not depend on wall-clock ordering", () => {
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(200).mockReturnValueOnce(100);
    try {
      const first = new VoicePlayer();
      const second = new VoicePlayer();
      first.setPlaybackOwnerId("rust-owner-first");
      second.setPlaybackOwnerId("rust-owner-second");

      expect(first.getPlaybackOwnershipState().ownerId).toBe("rust-owner-first");
      expect(second.getPlaybackOwnershipState().ownerId).toBe("rust-owner-second");
      expect(now).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("only clears the owner ID that lost its Rust lease", () => {
    const player = new VoicePlayer();
    player.setPlaybackOwnerId("current-owner");

    player.clearPlaybackOwnerId("stale-owner");
    expect(player.getPlaybackOwnershipState().ownerId).toBe("current-owner");

    player.clearPlaybackOwnerId("current-owner");
    player.setPlaybackOwnerId("reacquired-owner");
    expect(player.getPlaybackOwnershipState().ownerId).toBe("reacquired-owner");
  });

  it("合成中に再生を無効化した発話は、後から完了しても再生しない", async () => {
    let resolveSynth: (audio: ArrayBuffer) => void = () => {};
    const engine: TtsEngine = {
      name: "mock",
      synthesize: vi.fn(
        () =>
          new Promise<ArrayBuffer>((resolve) => {
            resolveSynth = resolve;
          }),
      ),
    };
    const player = new VoicePlayer(undefined, engine);
    const handle = player.createVoiceAPI().say("合成中");

    player.setPlaybackEnabled(false);
    await handle.completion;

    expect(handle.cancellationReason).toBe("playback-disabled");
    await expect(player.waitUntilIdle(100)).resolves.toBeUndefined();

    player.setPlaybackEnabled(true);
    resolveSynth(createMinimalWav());
    await flushPlaybackStart();

    expect(mockAudioContext.createBufferSource).not.toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledWith("tts_stop", {});
  });

  it("clip resolver 待機中の completion を即時 cancel し、再有効化後も再生しない", async () => {
    let resolveClip: (url: string) => void = () => {};
    const player = new VoicePlayer();
    const api = player.createVoiceAPI({
      resolveClip: () =>
        new Promise<string>((resolve) => {
          resolveClip = resolve;
        }),
    });
    const handle = api.play("clip:pending");
    await Promise.resolve();

    player.setPlaybackEnabled(false);
    await handle.completion;
    expect(handle.cancellationReason).toBe("playback-disabled");
    await expect(player.waitUntilIdle(100)).resolves.toBeUndefined();

    player.setPlaybackEnabled(true);
    resolveClip("/late.wav");
    await flushPlaybackStart();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockAudioContext.createBufferSource).not.toHaveBeenCalled();
  });

  it("clip fetch 待機中は AbortSignal を中断して completion を即時 cancel する", async () => {
    let fetchSignal: AbortSignal | undefined;
    mockFetch.mockImplementationOnce(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          fetchSignal = init?.signal ?? undefined;
          fetchSignal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const player = new VoicePlayer();
    const api = player.createVoiceAPI({ resolveClip: () => "/pending.wav" });
    const handle = api.play("clip:pending");
    await flushPlaybackStart();

    player.setPlaybackEnabled(false);
    await handle.completion;

    expect(fetchSignal?.aborted).toBe(true);
    expect(handle.cancellationReason).toBe("playback-disabled");
    await expect(player.waitUntilIdle(100)).resolves.toBeUndefined();
    expect(mockAudioContext.createBufferSource).not.toHaveBeenCalled();
  });

  it("cancel 後に再有効化しても古い synthesis generation は新しい発話を置き換えない", async () => {
    let resolveOldSynth: (audio: ArrayBuffer) => void = () => {};
    const engine: TtsEngine = {
      name: "mock",
      synthesize: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<ArrayBuffer>((resolve) => {
              resolveOldSynth = resolve;
            }),
        )
        .mockResolvedValueOnce(createMinimalWav()),
    };
    const player = new VoicePlayer(undefined, engine);
    const api = player.createVoiceAPI();
    const oldHandle = api.say("old");

    player.setPlaybackEnabled(false);
    await oldHandle.completion;
    player.setPlaybackEnabled(true);
    api.say("new");
    await flushPlaybackStart();
    const newSource = mockAudioContext.createBufferSource.mock.results[0].value;

    resolveOldSynth(createMinimalWav());
    await flushPlaybackStart();

    expect(mockAudioContext.createBufferSource).toHaveBeenCalledTimes(1);
    expect(newSource.stop).not.toHaveBeenCalled();
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

  it("mouth callback 未設定なら Web Audio 再生中も lip-sync rAF loop を開始しない", async () => {
    const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame");
    try {
      const engine = createMockEngine();
      const player = new VoicePlayer(undefined, engine);
      const api = player.createVoiceAPI();

      api.say("hello");
      await flushPlaybackStart();

      expect(rafSpy).not.toHaveBeenCalled();
      player.dispose();
    } finally {
      rafSpy.mockRestore();
    }
  });

  it("mouth callback 設定時は Web Audio 再生中に lip-sync rAF loop を開始する", async () => {
    const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame");
    try {
      const engine = createMockEngine();
      const player = new VoicePlayer(undefined, engine);
      const api = player.createVoiceAPI();

      player.setMouthCallback(vi.fn());
      api.say("hello");
      await flushPlaybackStart();

      expect(rafSpy).toHaveBeenCalled();
      player.dispose();
    } finally {
      rafSpy.mockRestore();
    }
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

  it("dispose() は Web Audio graph を disconnect する", async () => {
    const engine = createMockEngine();
    const player = new VoicePlayer(undefined, engine);
    const api = player.createVoiceAPI();

    api.say("hello");
    await flushPlaybackStart();
    const analyser = mockAudioContext.createAnalyser.mock.results[0].value;
    const silentSink = mockAudioContext.createGain.mock.results[0].value;
    const outputGain = mockAudioContext.createGain.mock.results[1].value;
    const masterGain = mockAudioContext.createGain.mock.results[2].value;

    player.dispose();

    expect(analyser.disconnect).toHaveBeenCalled();
    expect(silentSink.disconnect).toHaveBeenCalled();
    expect(outputGain.disconnect).toHaveBeenCalled();
    expect(masterGain.disconnect).toHaveBeenCalled();
  });

  it("PCM WAV は native decodeAudioData を優先する", async () => {
    const engine = createMockEngine();
    const player = new VoicePlayer(undefined, engine);
    const api = player.createVoiceAPI();

    api.say("hello");
    await flushPlaybackStart();

    expect(mockAudioContext.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(mockAudioContext.createBuffer).not.toHaveBeenCalled();
  });

  it("native decodeAudioData が失敗した場合だけ PCM WAV を直接 AudioBuffer に変換する", async () => {
    mockAudioContext.decodeAudioData.mockImplementationOnce(async (audioData: ArrayBuffer) => {
      detachAudioData(audioData);
      throw new DOMException("Decoding failed", "EncodingError");
    });
    const engine = createMockEngine();
    const player = new VoicePlayer(undefined, engine);
    const api = player.createVoiceAPI();

    api.say("hello");
    await flushPlaybackStart();

    expect(mockAudioContext.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(mockAudioContext.createBuffer).toHaveBeenCalledWith(1, 480, 24000);
    expect(mockInvoke).not.toHaveBeenCalledWith("tts_speak", expect.anything());
  });

  it("say() は Web Audio 再生時に volume option を反映する", async () => {
    const engine = createMockEngine();
    const player = new VoicePlayer(undefined, engine);
    const api = player.createVoiceAPI();

    api.say("hello", { volume: 0.5 });
    await flushPlaybackStart();

    const outputGain = mockAudioContext.createGain.mock.results[1].value;
    expect(outputGain.gain.setValueAtTime).toHaveBeenCalledWith(0.5, mockAudioContext.currentTime);
  });

  it("解析用 AnalyserNode は silent sink 経由で destination に接続される", async () => {
    const engine = createMockEngine();
    const player = new VoicePlayer(undefined, engine);
    const api = player.createVoiceAPI();

    api.say("hello");
    await flushPlaybackStart();

    const analyser = mockAudioContext.createAnalyser.mock.results[0].value;
    const silentSink = mockAudioContext.createGain.mock.results[0].value;
    const outputGain = mockAudioContext.createGain.mock.results[1].value;
    const masterGain = mockAudioContext.createGain.mock.results[2].value;
    const source = mockAudioContext.createBufferSource.mock.results[0].value;

    expect(silentSink.gain.value).toBe(0);
    expect(analyser.connect).toHaveBeenCalledWith(silentSink);
    expect(silentSink.connect).toHaveBeenCalledWith(mockAudioContext.destination);
    expect(outputGain.connect).toHaveBeenCalledWith(masterGain);
    expect(masterGain.connect).toHaveBeenCalledWith(mockAudioContext.destination);
    expect(source.connect).toHaveBeenCalledWith(analyser);
    expect(source.connect).toHaveBeenCalledWith(outputGain);
  });

  it("master voice volume は再生中に即時反映され、analyser 経路を維持する", async () => {
    getVoiceVolumeStore().set(0.6);
    const player = new VoicePlayer(undefined, createMockEngine());
    player.createVoiceAPI().say("hello");
    await flushPlaybackStart();
    const analyser = mockAudioContext.createAnalyser.mock.results[0].value;
    const silentSink = mockAudioContext.createGain.mock.results[0].value;
    const masterGain = mockAudioContext.createGain.mock.results[2].value;
    const source = mockAudioContext.createBufferSource.mock.results[0].value;

    expect(masterGain.gain.value).toBe(0.6);
    getVoiceVolumeStore().set(0);

    expect(masterGain.gain.setValueAtTime).toHaveBeenCalledWith(0, mockAudioContext.currentTime);
    expect(source.connect).toHaveBeenCalledWith(analyser);
    expect(analyser.connect).toHaveBeenCalledWith(silentSink);
    source.onended?.();
    player.dispose();
  });

  it("Web Audio 再生に失敗した場合は OS TTS にフォールバックする", async () => {
    mockAudioContext.decodeAudioData.mockImplementationOnce(async (audioData: ArrayBuffer) => {
      detachAudioData(audioData);
      throw new DOMException("Decoding failed", "EncodingError");
    });
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

  it("AudioContext を復旧できない場合は Web Audio 再生へ進まず OS TTS にフォールバックする", async () => {
    mockEnsureAudioContextRunning.mockRejectedValueOnce(
      new Error("AudioContext is not running after resume (state: interrupted)"),
    );
    const engine = createMockEngine();
    const player = new VoicePlayer("Kyoko", engine);
    const api = player.createVoiceAPI();
    const handle = api.say("hello");

    await handle.completion;

    expect(mockAudioContext.createBufferSource).not.toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledWith("tts_speak", {
      text: "hello",
      voice: "Kyoko",
    });
    expect(player.sampleMouth()).toEqual({ aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 });
  });

  it("OS TTS フォールバック中は mouth 値を返さない", async () => {
    mockAudioContext.decodeAudioData.mockImplementationOnce(async (audioData: ArrayBuffer) => {
      detachAudioData(audioData);
      throw new DOMException("Decoding failed", "EncodingError");
    });
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
      disconnect: vi.fn(),
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
    await flushPlaybackStart();

    const mouth = player.sampleMouth();
    expect(mouth.aa).toBeGreaterThan(0);
    expect(mouth.ih).toBe(0);
    expect(mockAudioContext.decodeAudioData).toHaveBeenCalledTimes(1);
  });

  it("Web Audio analyser が無信号なら合成 buffer だけでは mouth 値を出さない", async () => {
    const engine: TtsEngine = {
      name: "mock",
      synthesize: vi.fn(async () => createMinimalWav(16000, 24000)),
    };
    const player = new VoicePlayer(undefined, engine);
    const api = player.createVoiceAPI();

    api.say("あ");
    await flushPlaybackStart();

    expect(player.sampleMouth()).toEqual({ aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 });
  });

  it("再生中でない sampleMouth() は analyser を pull しない", async () => {
    const getByteFrequencyData = vi.fn((out: Uint8Array) => out.fill(0));
    const getByteTimeDomainData = vi.fn((out: Uint8Array) => {
      for (let i = 0; i < out.length; i++) out[i] = i % 2 === 0 ? 96 : 160;
      return out;
    });
    mockAudioContext.createAnalyser.mockReturnValueOnce({
      connect: vi.fn(),
      disconnect: vi.fn(),
      fftSize: 256,
      frequencyBinCount: 128,
      getByteFrequencyData,
      getByteTimeDomainData,
    });
    const engine = createMockEngine();
    const player = new VoicePlayer(undefined, engine);
    const api = player.createVoiceAPI();

    api.say("あ");
    await flushPlaybackStart();
    expect(player.isMouthActive()).toBe(true);
    expect(player.sampleMouth().aa).toBeGreaterThan(0);
    expect(getByteFrequencyData).toHaveBeenCalledTimes(1);
    expect(getByteTimeDomainData).toHaveBeenCalledTimes(1);

    const source = mockAudioContext.createBufferSource.mock.results[0].value;
    source.onended?.();
    getByteFrequencyData.mockClear();
    getByteTimeDomainData.mockClear();

    expect(player.isMouthActive()).toBe(false);
    expect(player.sampleMouth()).toEqual({ aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 });
    expect(getByteFrequencyData).not.toHaveBeenCalled();
    expect(getByteTimeDomainData).not.toHaveBeenCalled();
  });

  it("未開始の play handle を stop しても既存の say 再生は止めない", async () => {
    const engine = createMockEngine();
    const player = new VoicePlayer(undefined, engine);
    const api = player.createVoiceAPI();
    api.say("hello");
    await flushPlaybackStart();
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

  it("dispose() は古い fade timer の gain 復元を無効化する", async () => {
    const engine = createMockEngine();
    const player = new VoicePlayer(undefined, engine);
    const api = player.createVoiceAPI();
    const handle = api.say("hello", { volume: 0.3 });
    await flushPlaybackStart();
    const outputGain = mockAudioContext.createGain.mock.results[1].value;

    await handle.stop();
    player.dispose();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(outputGain.gain.setValueAtTime).not.toHaveBeenCalledWith(
      1,
      mockAudioContext.currentTime,
    );
    expect(outputGain.gain.value).not.toBe(1);
  });
});

// ---------------------------------------------------------------------------
// waitUntilIdle — お別れ切替が声を待つための idle 判定
// ---------------------------------------------------------------------------

describe("VoicePlayer.waitUntilIdle", () => {
  afterEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(() => Promise.resolve());
    mockAudioContext.createAnalyser.mockClear();
    mockAudioContext.createGain.mockClear();
    mockAudioContext.createBufferSource.mockClear();
    mockAudioContext.createBuffer.mockClear();
    mockAudioContext.decodeAudioData.mockReset();
    mockAudioContext.decodeAudioData.mockImplementation(async (audioData: ArrayBuffer) => {
      detachAudioData(audioData);
      return { duration: 0.02, length: 480, sampleRate: 24000 };
    });
    mockFetch.mockReset();
    mockEnsureAudioContextRunning.mockReset();
    mockEnsureAudioContextRunning.mockResolvedValue(mockAudioContext);
  });

  it("何も再生していなければ即座に解決する", async () => {
    const player = new VoicePlayer();
    await expect(player.waitUntilIdle(1000)).resolves.toBeUndefined();
  });

  it("WebAudio 再生中は onended まで解決しない", async () => {
    const engine = createMockEngine();
    const player = new VoicePlayer(undefined, engine);
    const api = player.createVoiceAPI();
    api.say("お別れの言葉");
    await flushPlaybackStart();
    const source = mockAudioContext.createBufferSource.mock.results[0].value;

    let settled = false;
    const wait = player.waitUntilIdle(5000).then(() => {
      settled = true;
    });
    await flushPlaybackStart();
    expect(settled).toBe(false);

    source.onended?.();
    await wait;
    expect(settled).toBe(true);
  });

  it("合成中（再生開始前）でも解決しない", async () => {
    let resolveSynth: (v: ArrayBuffer) => void = () => {};
    const engine: TtsEngine = {
      name: "mock",
      synthesize: vi.fn(
        () =>
          new Promise<ArrayBuffer>((resolve) => {
            resolveSynth = resolve;
          }),
      ),
    };
    const player = new VoicePlayer(undefined, engine);
    const api = player.createVoiceAPI();
    api.say("合成待ち");

    let settled = false;
    void player.waitUntilIdle(5000).then(() => {
      settled = true;
    });
    await flushPlaybackStart();
    expect(settled).toBe(false);

    resolveSynth(createMinimalWav());
    await flushPlaybackStart();
    const source = mockAudioContext.createBufferSource.mock.results[0].value;
    source.onended?.();
    await flushPlaybackStart();
    expect(settled).toBe(true);
  });

  it("timeout を超えたら諦めて解決する（切替を止めない）", async () => {
    const engine = createMockEngine();
    const player = new VoicePlayer(undefined, engine);
    const api = player.createVoiceAPI();
    api.say("終わらないセリフ");
    await flushPlaybackStart();
    await expect(player.waitUntilIdle(50)).resolves.toBeUndefined();
  });

  it("OS TTS フォールバックの発話完了も待つ", async () => {
    let resolveSpeak: () => void = () => {};
    mockInvoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSpeak = () => resolve();
        }),
    );
    const player = new VoicePlayer();
    const api = player.createVoiceAPI();
    api.say("os tts");

    let settled = false;
    void player.waitUntilIdle(5000).then(() => {
      settled = true;
    });
    await flushPlaybackStart();
    expect(settled).toBe(false);

    resolveSpeak();
    await flushPlaybackStart();
    expect(settled).toBe(true);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

import { VoicePlayer } from "./voice-player";

describe("VoicePlayer", () => {
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

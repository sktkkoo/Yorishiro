import { afterEach, describe, expect, it, vi } from "vitest";

const { channels, mockInvoke } = vi.hoisted(() => ({
  channels: [] as Array<{ onmessage: ((data: ArrayBuffer) => void) | null }>,
  mockInvoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class MockChannel {
    onmessage: ((data: ArrayBuffer) => void) | null = null;

    constructor() {
      channels.push(this);
    }
  },
  invoke: mockInvoke,
}));

import { SayTtsEngine } from "./tts-engine";

describe("SayTtsEngine", () => {
  afterEach(() => {
    channels.length = 0;
    mockInvoke.mockReset();
  });

  it("receives synthesized WAV bytes through a raw Channel", async () => {
    const expected = new Uint8Array([1, 2, 3]);
    mockInvoke.mockImplementationOnce(
      async (_command: string, args: { onOutput: (typeof channels)[number] }) => {
        args.onOutput.onmessage?.(expected.buffer);
      },
    );

    const audio = await new SayTtsEngine().synthesize("hello", "Kyoko");

    expect(new Uint8Array(audio)).toEqual(expected);
    expect(mockInvoke).toHaveBeenCalledWith("tts_synthesize", {
      text: "hello",
      voice: "Kyoko",
      onOutput: channels[0],
    });
  });
});

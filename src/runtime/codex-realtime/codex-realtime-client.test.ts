// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexRealtimeClient, type CodexRealtimeState } from "./codex-realtime-client";

interface FakeChannel<T> {
  onmessage: (message: T) => void;
}

interface SentMessage {
  readonly method: string;
  readonly id?: number;
  readonly params?: Record<string, unknown>;
}

const bridge = vi.hoisted(() => ({
  channel: null as FakeChannel<string> | null,
  sent: [] as SentMessage[],
  disconnect: vi.fn(async () => {}),
  accountType: "chatgpt",
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class<T> {
    onmessage: (message: T) => void = () => {};
  },
}));

vi.mock("../../bindings/tauri-commands", () => ({
  sessionRealtimeConnect: vi.fn(
    async ({ onMessage }: { onMessage: FakeChannel<string> }): Promise<string> => {
      bridge.channel = onMessage;
      return "connection-1";
    },
  ),
  sessionRealtimeSend: vi.fn(
    async ({ message }: { connectionId: string; message: string }): Promise<void> => {
      const request = JSON.parse(message) as SentMessage;
      bridge.sent.push(request);
      if (request.id === undefined) return;

      const respond = (result: unknown) => {
        queueMicrotask(() => {
          bridge.channel?.onmessage(JSON.stringify({ id: request.id, result }));
        });
      };

      if (request.method === "account/read") {
        respond({ account: { type: bridge.accountType, planType: "plus" } });
      } else if (request.method === "thread/loaded/list") {
        respond({ data: ["thread-1"], nextCursor: null });
      } else {
        respond({});
      }
      if (request.method === "thread/realtime/start") {
        queueMicrotask(() => {
          bridge.channel?.onmessage(
            JSON.stringify({
              method: "thread/realtime/sdp",
              params: { threadId: "thread-1", sdp: "remote-answer" },
            }),
          );
        });
      }
    },
  ),
  sessionRealtimeDisconnect: bridge.disconnect,
}));

vi.mock("../../core/voice/audio-context", () => ({
  ensureAudioContextRunning: vi.fn(async () => ({})),
}));

class FakeAudioTrack {
  readonly kind = "audio";
  readonly stop = vi.fn();
}

class FakeMediaStream {
  private readonly tracks: FakeAudioTrack[];

  constructor(tracks: FakeAudioTrack[] = []) {
    this.tracks = [...tracks];
  }

  getTracks(): FakeAudioTrack[] {
    return [...this.tracks];
  }

  getAudioTracks(): FakeAudioTrack[] {
    return this.getTracks();
  }

  addTrack(track: FakeAudioTrack): void {
    this.tracks.push(track);
  }
}

class FakeDataChannel {
  readonly close = vi.fn();
}

class FakePeerConnection extends EventTarget {
  static latest: FakePeerConnection | null = null;
  readonly iceGatheringState = "complete";
  readonly connectionState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  readonly channel = new FakeDataChannel();
  readonly close = vi.fn();
  readonly setRemoteDescription = vi.fn(async (_description: RTCSessionDescriptionInit) => {});

  constructor() {
    super();
    FakePeerConnection.latest = this;
  }

  addTrack(): void {}

  createDataChannel(): FakeDataChannel {
    return this.channel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "local-offer" };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
  }
}

describe("CodexRealtimeClient", () => {
  let microphoneTrack: FakeAudioTrack;

  beforeEach(() => {
    microphoneTrack = new FakeAudioTrack();
    vi.stubGlobal("MediaStream", FakeMediaStream);
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    bridge.channel = null;
    bridge.sent = [];
    bridge.disconnect.mockClear();
    bridge.accountType = "chatgpt";
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => new FakeMediaStream([microphoneTrack])),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    FakePeerConnection.latest = null;
  });

  it("joins the loaded TUI thread through realtime v3 WebRTC and releases the microphone", async () => {
    const states: CodexRealtimeState[] = [];
    const client = new CodexRealtimeClient("main-session", (state) => states.push(state));

    await client.start();

    expect(client.getStatus()).toBe("active");
    expect(states.map((state) => state.status)).toEqual(["connecting", "active"]);
    expect(states[states.length - 1]).toEqual({ status: "active", billing: "subscription" });
    const start = bridge.sent.find((message) => message.method === "thread/realtime/start");
    expect(start?.params).toMatchObject({
      threadId: "thread-1",
      outputModality: "audio",
      version: "v3",
      voice: "sol",
      transport: { type: "webrtc", sdp: "local-offer" },
    });
    expect(FakePeerConnection.latest?.setRemoteDescription).toHaveBeenCalledWith({
      type: "answer",
      sdp: "remote-answer",
    });

    client.stop();

    expect(microphoneTrack.stop).toHaveBeenCalledTimes(1);
    expect(bridge.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "connection-1",
        finalMessage: expect.stringContaining('"method":"thread/realtime/stop"'),
      }),
    );
    expect(client.getStatus()).toBe("idle");
  });

  it("uses API-key auth and exposes API billing before requesting the microphone", async () => {
    bridge.accountType = "apiKey";
    const states: CodexRealtimeState[] = [];
    const client = new CodexRealtimeClient("main-session", (state) => states.push(state));

    await client.start();

    expect(states).toEqual([
      { status: "connecting" },
      { status: "connecting", billing: "api" },
      { status: "active", billing: "api" },
    ]);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(bridge.sent.some((message) => message.method === "thread/realtime/start")).toBe(true);
    expect(client.getStatus()).toBe("active");
  });
});

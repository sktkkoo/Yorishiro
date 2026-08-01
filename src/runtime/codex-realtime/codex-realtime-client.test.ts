// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAudioContextRunning } from "../../core/voice/audio-context";
import type { MouthValues } from "../../core/voice/mouth-values";
import { CodexRealtimeClient, type CodexRealtimeState } from "./codex-realtime-client";

interface FakeChannel<T> {
  onmessage: (message: T) => void;
}

interface SentMessage {
  readonly method?: string;
  readonly id?: number;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
}

const bridge = vi.hoisted(() => ({
  channel: null as FakeChannel<string> | null,
  sent: [] as SentMessage[],
  connect: vi.fn(async ({ onMessage }: { onMessage: FakeChannel<string> }): Promise<string> => {
    bridge.channel = onMessage;
    return bridge.connectPromise ? await bridge.connectPromise : "connection-1";
  }),
  connectPromise: null as Promise<string> | null,
  disconnect: vi.fn(async () => {}),
  accountType: "chatgpt",
  accountPrelude: null as "server-request" | "id-only" | "error-response" | null,
  loadedThreadResponses: [] as string[][],
  loadedThreadParents: {} as Record<string, string | null | undefined>,
  threadReadFailures: {} as Record<string, number>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class<T> {
    onmessage: (message: T) => void = () => {};
  },
}));

vi.mock("../../bindings/tauri-commands", () => ({
  sessionRealtimeConnect: bridge.connect,
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
        if (bridge.accountPrelude === "error-response") {
          queueMicrotask(() => {
            bridge.channel?.onmessage(
              JSON.stringify({ id: request.id, error: { message: "account failed" } }),
            );
          });
          return;
        }
        if (bridge.accountPrelude === "server-request") {
          queueMicrotask(() => {
            bridge.channel?.onmessage(
              JSON.stringify({
                id: request.id,
                method: "item/commandExecution/requestApproval",
                params: { reason: "test" },
              }),
            );
          });
        } else if (bridge.accountPrelude === "id-only") {
          queueMicrotask(() => {
            bridge.channel?.onmessage(JSON.stringify({ id: request.id }));
          });
        }
        respond({ account: { type: bridge.accountType, planType: "plus" } });
      } else if (request.method === "thread/loaded/list") {
        const loadedThreads =
          bridge.loadedThreadResponses.length > 1
            ? bridge.loadedThreadResponses.shift()
            : bridge.loadedThreadResponses[0];
        respond({
          data: loadedThreads ?? ["thread-1"],
          nextCursor: null,
        });
      } else if (request.method === "thread/read") {
        const threadId = request.params?.threadId;
        if (typeof threadId === "string" && (bridge.threadReadFailures[threadId] ?? 0) > 0) {
          bridge.threadReadFailures[threadId] -= 1;
          queueMicrotask(() => {
            bridge.channel?.onmessage(
              JSON.stringify({ id: request.id, error: { message: "thread disappeared" } }),
            );
          });
          return;
        }
        const hasParent =
          typeof threadId === "string" &&
          Object.getOwnPropertyDescriptor(bridge.loadedThreadParents, threadId) !== undefined;
        const parentThreadId =
          typeof threadId === "string" && hasParent ? bridge.loadedThreadParents[threadId] : null;
        respond({
          thread: {
            id: threadId,
            ...(parentThreadId !== undefined ? { parentThreadId } : {}),
          },
        });
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
    bridge.connect.mockClear();
    bridge.connectPromise = null;
    bridge.disconnect.mockClear();
    bridge.accountType = "chatgpt";
    bridge.accountPrelude = null;
    bridge.loadedThreadResponses = [];
    bridge.loadedThreadParents = {};
    vi.mocked(ensureAudioContextRunning).mockReset();
    vi.mocked(ensureAudioContextRunning).mockResolvedValue({} as AudioContext);
    bridge.threadReadFailures = {};
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => new FakeMediaStream([microphoneTrack])),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("routes assistant transcript to state expressions and cancels them on user barge-in", async () => {
    const onCue = vi.fn();
    const onRelease = vi.fn();
    const client = new CodexRealtimeClient("main-session", undefined, {
      stateExpressionCallbacks: { onCue, onRelease },
    });
    await client.start();

    bridge.channel?.onmessage(
      JSON.stringify({
        method: "thread/realtime/transcript/delta",
        params: { threadId: "thread-1", role: "assistant", delta: "はい。" },
      }),
    );
    bridge.channel?.onmessage(
      JSON.stringify({
        method: "thread/realtime/transcript/done",
        params: { threadId: "thread-1", role: "assistant", text: "はい。" },
      }),
    );
    bridge.channel?.onmessage(
      JSON.stringify({
        method: "thread/realtime/transcript/delta",
        params: { threadId: "thread-1", role: "user", delta: "待って" },
      }),
    );

    // audio start前なのでcueはqueueのまま。barge-inはそのqueueと所有slotを解放する。
    expect(onCue).not.toHaveBeenCalled();
    expect(onRelease).toHaveBeenCalledWith("realtime-1", "cancelled");
    client.stop();
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it("routes item and output-audio ownership boundaries to state expressions", async () => {
    const client = new CodexRealtimeClient("main-session", undefined, {
      stateExpressionCallbacks: { onCue: vi.fn(), onRelease: vi.fn() },
    });
    await client.start();
    const controller = (
      client as unknown as {
        stateExpressionController: {
          onUserSpeechStarted(itemId?: unknown): void;
          onAssistantResponseBoundary(itemId: unknown): void;
          onOutputAudioItem(itemId: unknown): void;
        };
      }
    ).stateExpressionController;
    const onUserSpeechStarted = vi.spyOn(controller, "onUserSpeechStarted");
    const onAssistantResponseBoundary = vi.spyOn(controller, "onAssistantResponseBoundary");
    const onOutputAudioItem = vi.spyOn(controller, "onOutputAudioItem");

    bridge.channel?.onmessage(
      JSON.stringify({
        method: "thread/realtime/itemAdded",
        params: {
          threadId: "thread-1",
          item: { type: "input_audio_buffer.speech_started", item_id: "user-1" },
        },
      }),
    );
    bridge.channel?.onmessage(
      JSON.stringify({
        method: "thread/realtime/itemAdded",
        params: { threadId: "thread-1", item: { id: "assistant-1", role: "assistant" } },
      }),
    );
    bridge.channel?.onmessage(
      JSON.stringify({
        method: "thread/realtime/outputAudio/delta",
        params: { threadId: "thread-1", audio: { itemId: "assistant-1" } },
      }),
    );

    expect(onUserSpeechStarted).toHaveBeenCalledWith("user-1");
    expect(onAssistantResponseBoundary).toHaveBeenCalledWith("assistant-1");
    expect(onOutputAudioItem).toHaveBeenCalledWith("assistant-1");
    client.stop();
  });

  it("tracks remote speech while rendering is paused without Body sampling", async () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const onCue = vi.fn();
    const onRelease = vi.fn();
    const client = new CodexRealtimeClient("main-session", undefined, {
      stateExpressionCallbacks: { onCue, onRelease },
    });
    let signalSampleCount = 0;
    const internals = client as unknown as {
      state: CodexRealtimeState;
      lipSync: {
        sample(out?: MouthValues): MouthValues;
        hasSignal(): boolean;
        reset(): void;
      };
      stateExpressionController: {
        onTranscriptDelta(role: unknown, delta: unknown): void;
        onTranscriptDone(role: unknown): void;
      };
      startRemoteSpeechObservation(attempt: number): void;
    };
    internals.state = { status: "active" };
    internals.lipSync = {
      sample: vi.fn(() => ({ aa: 0.8, ih: 0, ou: 0, ee: 0, oh: 0 })),
      hasSignal: () => {
        signalSampleCount++;
        return signalSampleCount === 1;
      },
      reset: vi.fn(),
    };
    internals.stateExpressionController.onTranscriptDelta("assistant", "はい。");
    internals.stateExpressionController.onTranscriptDone("assistant");

    internals.startRemoteSpeechObservation(0);
    await vi.advanceTimersByTimeAsync(1_600);

    expect(signalSampleCount).toBeGreaterThan(1);
    expect(onCue).toHaveBeenCalledOnce();
    expect(onRelease).toHaveBeenCalledWith("realtime-1", "completed");

    client.stop();
    const stoppedSampleCount = signalSampleCount;
    await vi.advanceTimersByTimeAsync(100);
    expect(signalSampleCount).toBe(stoppedSampleCount);
    hidden.mockRestore();
  });

  it("samples fresh mouth values on every Body render pull", () => {
    const client = new CodexRealtimeClient("main-session");
    let renderSampleCount = 0;
    const internals = client as unknown as {
      state: CodexRealtimeState;
      lipSync: {
        sample(out?: MouthValues): MouthValues;
        hasSignal(): boolean;
        reset(): void;
      };
    };
    internals.state = { status: "active" };
    internals.lipSync = {
      sample: () => ({ aa: ++renderSampleCount / 10, ih: 0, ou: 0, ee: 0, oh: 0 }),
      hasSignal: () => true,
      reset: vi.fn(),
    };

    expect(client.sampleMouth().aa).toBe(0.1);
    expect(client.sampleMouth().aa).toBe(0.2);
  });

  it("ignores transcript notifications for a different thread", async () => {
    const onRelease = vi.fn();
    const client = new CodexRealtimeClient("main-session", undefined, {
      stateExpressionCallbacks: { onCue: vi.fn(), onRelease },
    });
    await client.start();

    bridge.channel?.onmessage(
      JSON.stringify({
        method: "thread/realtime/transcript/delta",
        params: { threadId: "other-thread", role: "assistant", delta: "はい。" },
      }),
    );
    client.stop();

    expect(onRelease).not.toHaveBeenCalled();
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

  it("keeps an id+method server request separate from the matching response", async () => {
    bridge.accountPrelude = "server-request";
    const client = new CodexRealtimeClient("main-session");

    await client.start();

    expect(client.getStatus()).toBe("active");
    expect(bridge.sent.every((message) => typeof message.method === "string")).toBe(true);
  });

  it("ignores an id-only message until a result or error response arrives", async () => {
    bridge.accountPrelude = "id-only";
    const client = new CodexRealtimeClient("main-session");

    await client.start();

    expect(client.getStatus()).toBe("active");
  });

  it("rejects a matching id+error response", async () => {
    bridge.accountPrelude = "error-response";
    const client = new CodexRealtimeClient("main-session");

    await expect(client.start()).rejects.toThrow("account failed");

    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(client.getStatus()).toBe("error");
  });

  it("waits while no thread is loaded and uses the sole loaded thread", async () => {
    bridge.loadedThreadResponses = [[], ["thread-after-wait"]];
    const client = new CodexRealtimeClient("main-session");

    await client.start();

    expect(
      bridge.sent.find((message) => message.method === "thread/realtime/start")?.params,
    ).toMatchObject({ threadId: "thread-after-wait" });
    expect(bridge.sent.filter((message) => message.method === "thread/loaded/list")).toHaveLength(
      3,
    );
  });

  it("selects the sole top-level thread when its subagents are also loaded", async () => {
    bridge.loadedThreadResponses = [["main-thread", "subagent-1", "subagent-2"]];
    bridge.loadedThreadParents = {
      "main-thread": null,
      "subagent-1": "main-thread",
      "subagent-2": "main-thread",
    };
    const client = new CodexRealtimeClient("main-session");

    await client.start();

    expect(
      bridge.sent.find((message) => message.method === "thread/realtime/start")?.params,
    ).toMatchObject({ threadId: "main-thread" });
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("retries the whole loaded snapshot when one thread/read races with subagent exit", async () => {
    bridge.loadedThreadResponses = [
      ["main-thread", "subagent-1"],
      ["main-thread", "subagent-1"],
    ];
    bridge.loadedThreadParents = { "main-thread": null, "subagent-1": "main-thread" };
    bridge.threadReadFailures = { "subagent-1": 1 };
    const client = new CodexRealtimeClient("main-session");

    await client.start();

    expect(bridge.sent.filter((message) => message.method === "thread/loaded/list")).toHaveLength(
      3,
    );
    expect(bridge.sent.filter((message) => message.method === "thread/read")).toHaveLength(4);
    expect(
      bridge.sent.find((message) => message.method === "thread/realtime/start")?.params,
    ).toMatchObject({ threadId: "main-thread" });
  });

  it("rejects a stale candidate when a second top-level thread loads during discovery", async () => {
    bridge.loadedThreadResponses = [
      ["main-thread", "subagent-1"],
      ["main-thread", "subagent-1", "second-thread"],
    ];
    bridge.loadedThreadParents = {
      "main-thread": null,
      "subagent-1": "main-thread",
      "second-thread": null,
    };
    const client = new CodexRealtimeClient("main-session");

    await expect(client.start()).rejects.toThrow("Multiple top-level Codex threads are loaded");

    expect(bridge.sent.filter((message) => message.method === "thread/loaded/list")).toHaveLength(
      3,
    );
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(bridge.sent.some((message) => message.method === "thread/realtime/start")).toBe(false);
  });

  it("fails closed before microphone access when multiple top-level threads are loaded", async () => {
    bridge.loadedThreadResponses = [["thread-1", "thread-2"]];
    bridge.loadedThreadParents = { "thread-1": null, "thread-2": null };
    const client = new CodexRealtimeClient("main-session");

    await expect(client.start()).rejects.toThrow("Multiple top-level Codex threads are loaded");

    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(bridge.sent.some((message) => message.method === "thread/realtime/start")).toBe(false);
    expect(client.getStatus()).toBe("error");
  });

  it("uses the tracker-selected top-level thread while a cleared thread remains loaded", async () => {
    bridge.loadedThreadResponses = [["cleared-thread", "current-thread"]];
    bridge.loadedThreadParents = { "cleared-thread": null, "current-thread": null };
    const client = new CodexRealtimeClient("main-session", undefined, {
      getPreferredThreadId: () => "current-thread",
    });

    await client.start();

    expect(
      bridge.sent.find((message) => message.method === "thread/realtime/start")?.params,
    ).toMatchObject({ threadId: "current-thread" });
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("fails closed when thread/read omits the subagent relationship", async () => {
    bridge.loadedThreadResponses = [["thread-1", "thread-2"]];
    bridge.loadedThreadParents = { "thread-1": null, "thread-2": undefined };
    const client = new CodexRealtimeClient("main-session");

    await expect(client.start()).rejects.toThrow("Codex returned an invalid loaded thread");

    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(bridge.sent.some((message) => message.method === "thread/realtime/start")).toBe(false);
  });

  it("disconnects a bridge connection that arrives after the connect timeout", async () => {
    vi.useFakeTimers();
    let resolveConnection: ((connectionId: string) => void) | undefined;
    bridge.connectPromise = new Promise((resolve) => {
      resolveConnection = resolve;
    });
    const client = new CodexRealtimeClient("main-session");
    const result = client.start().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toEqual(new Error("Codex app-server connection timed out"));

    resolveConnection?.("late-connection");
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.disconnect).toHaveBeenCalledWith({ connectionId: "late-connection" });
    expect(client.getStatus()).toBe("error");
  });

  it("stops microphone tracks returned after stop invalidates the start attempt", async () => {
    let resolveMicrophone: ((stream: FakeMediaStream) => void) | undefined;
    const microphone = new Promise<FakeMediaStream>((resolve) => {
      resolveMicrophone = resolve;
    });
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValueOnce(
      microphone as unknown as Promise<MediaStream>,
    );
    const client = new CodexRealtimeClient("main-session");
    const result = client.start().catch((error: unknown) => error);
    await vi.waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1));

    client.stop();
    resolveMicrophone?.(new FakeMediaStream([microphoneTrack]));
    expect(await result).toBeInstanceOf(Error);

    expect(microphoneTrack.stop).toHaveBeenCalledTimes(1);
    expect(bridge.sent.some((message) => message.method === "thread/realtime/start")).toBe(false);
    expect(client.getStatus()).toBe("idle");
  });

  it("does not let a late stopped attempt dispose a newer active attempt", async () => {
    const lateTrack = new FakeAudioTrack();
    let resolveMicrophone: ((stream: FakeMediaStream) => void) | undefined;
    const microphone = new Promise<FakeMediaStream>((resolve) => {
      resolveMicrophone = resolve;
    });
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValueOnce(
      microphone as unknown as Promise<MediaStream>,
    );
    const client = new CodexRealtimeClient("main-session");
    const firstResult = client.start().catch((error: unknown) => error);
    await vi.waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1));

    client.stop();
    await client.start();
    resolveMicrophone?.(new FakeMediaStream([lateTrack]));
    expect(await firstResult).toBeInstanceOf(Error);

    expect(lateTrack.stop).toHaveBeenCalledTimes(1);
    expect(microphoneTrack.stop).not.toHaveBeenCalled();
    expect(client.getStatus()).toBe("active");
  });

  it("ignores remote audio setup failure from an invalidated attempt", async () => {
    let rejectRemoteAudio: ((error: Error) => void) | undefined;
    const remoteAudio = new Promise<AudioContext>((_resolve, reject) => {
      rejectRemoteAudio = reject;
    });
    const client = new CodexRealtimeClient("main-session");
    await client.start();
    const firstPeer = FakePeerConnection.latest;
    vi.mocked(ensureAudioContextRunning).mockReturnValueOnce(remoteAudio);

    const remoteTrack = new FakeAudioTrack();
    const remoteStream = new FakeMediaStream([remoteTrack]);
    const trackEvent = new Event("track");
    Object.defineProperties(trackEvent, {
      streams: { value: [remoteStream] },
      track: { value: remoteTrack },
    });
    firstPeer?.dispatchEvent(trackEvent);

    client.stop();
    await client.start();
    rejectRemoteAudio?.(new Error("stale remote audio failed"));
    await Promise.resolve();

    expect(client.getStatus()).toBe("active");
  });

  it("invalidates a pending start when realtime closes and releases a late microphone", async () => {
    let resolveMicrophone: ((stream: FakeMediaStream) => void) | undefined;
    const microphone = new Promise<FakeMediaStream>((resolve) => {
      resolveMicrophone = resolve;
    });
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValueOnce(
      microphone as unknown as Promise<MediaStream>,
    );
    const client = new CodexRealtimeClient("main-session");
    const result = client.start().catch((error: unknown) => error);
    await vi.waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1));

    bridge.channel?.onmessage(JSON.stringify({ method: "thread/realtime/closed", params: {} }));
    resolveMicrophone?.(new FakeMediaStream([microphoneTrack]));
    expect(await result).toBeInstanceOf(Error);

    expect(microphoneTrack.stop).toHaveBeenCalledTimes(1);
    expect(client.getStatus()).toBe("idle");
  });
});

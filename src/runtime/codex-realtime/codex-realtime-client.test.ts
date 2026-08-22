// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAudioContextRunning } from "../../core/voice/audio-context";
import type { MouthValues } from "../../core/voice/mouth-values";
import { getVoiceVolumeStore } from "../../core/voice/voice-volume-store";
import {
  CodexRealtimeClient,
  type CodexRealtimePersonaApplication,
  type CodexRealtimeState,
  type CodexRealtimeVoiceFallback,
} from "./codex-realtime-client";
import { readRealtimeDiagnostics } from "./realtime-diagnostics";

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
  disconnect: vi.fn(
    async (_args?: { readonly connectionId: string; readonly finalMessage?: string }) => {},
  ),
  accountType: "chatgpt",
  accountPrelude: null as "server-request" | "id-only" | "error-response" | null,
  loadedThreadResponses: [] as string[][],
  loadedThreadParents: {} as Record<string, string | null | undefined>,
  threadReadFailures: {} as Record<string, number>,
  /** voice → error message。entry がある voice の thread/realtime/start を error 応答にする。 */
  realtimeStartErrors: {} as Record<string, string>,
  /** version → error message。specific protocol rejection の compatibility test 用。 */
  realtimeStartVersionErrors: {} as Record<string, string>,
  initializeUserAgent: "codex_cli_rs/0.146.0",
  capabilities: { appServerVersion: "0.146.0", personaInitialItems: true },
  suppressRealtimeSdp: false,
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class<T> {
    onmessage: (message: T) => void = () => {};
  },
}));

vi.mock("../../bindings/tauri-commands", () => ({
  sessionRealtimeCapabilities: vi.fn(async () => bridge.capabilities),
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

      if (request.method === "initialize") {
        respond({ userAgent: bridge.initializeUserAgent });
      } else if (request.method === "account/read") {
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
      } else if (request.method === "thread/realtime/start") {
        const voice = request.params?.voice;
        const version = request.params?.version;
        const rejection =
          (typeof version === "string" ? bridge.realtimeStartVersionErrors[version] : undefined) ??
          (typeof voice === "string" ? bridge.realtimeStartErrors[voice] : undefined);
        if (rejection !== undefined) {
          queueMicrotask(() => {
            bridge.channel?.onmessage(
              JSON.stringify({ id: request.id, error: { message: rejection } }),
            );
          });
          return;
        }
        respond({});
        if (!bridge.suppressRealtimeSdp) {
          queueMicrotask(() => {
            bridge.channel?.onmessage(
              JSON.stringify({
                method: "thread/realtime/sdp",
                params: { threadId: "thread-1", sdp: "remote-answer" },
              }),
            );
          });
        }
      } else {
        respond({});
      }
    },
  ),
  sessionRealtimeDisconnect: bridge.disconnect,
}));

vi.mock("../../core/voice/audio-context", () => ({
  ensureAudioContextRunning: vi.fn(async () => ({})),
}));

class FakeAudioTrack extends EventTarget {
  readonly kind = "audio";
  enabled = true;
  muted = false;
  readyState: MediaStreamTrackState = "live";
  readonly stop = vi.fn();

  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    this.dispatchEvent(new Event(muted ? "mute" : "unmute"));
  }

  end(): void {
    if (this.readyState === "ended") return;
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

class FakeMediaStream extends EventTarget {
  private readonly tracks: FakeAudioTrack[];

  constructor(tracks: FakeAudioTrack[] = []) {
    super();
    this.tracks = [...tracks];
  }

  getTracks(): FakeAudioTrack[] {
    return [...this.tracks];
  }

  getAudioTracks(): FakeAudioTrack[] {
    return this.getTracks();
  }

  get active(): boolean {
    return this.tracks.some((track) => track.readyState === "live");
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
    localStorage.clear();
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
    bridge.initializeUserAgent = "codex_cli_rs/0.146.0";
    bridge.capabilities = { appServerVersion: "0.146.0", personaInitialItems: true };
    vi.mocked(ensureAudioContextRunning).mockReset();
    vi.mocked(ensureAudioContextRunning).mockResolvedValue({} as AudioContext);
    bridge.threadReadFailures = {};
    bridge.realtimeStartErrors = {};
    bridge.realtimeStartVersionErrors = {};
    bridge.suppressRealtimeSdp = false;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => new FakeMediaStream([microphoneTrack])),
      },
    });
  });

  afterEach(() => {
    getVoiceVolumeStore().set(1);
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
    expect(states[states.length - 1]).toEqual({
      status: "active",
      billing: "subscription",
      microphoneActive: true,
    });
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

  it("supplements Codex realtime with the active persona as a developer initial item", async () => {
    const diagnostics: CodexRealtimePersonaApplication[] = [];
    const client = new CodexRealtimeClient("main-session", undefined, {
      getPersonaSnapshot: () => ({
        personaId: "bundled-yori",
        instructions: "  persona speaking guidance  ",
      }),
      onPersonaApplication: (application) => diagnostics.push(application),
    });

    await client.start();

    const start = bridge.sent.find((message) => message.method === "thread/realtime/start");
    expect(start?.params?.initialItems).toEqual([
      { role: "developer", text: "persona speaking guidance" },
    ]);
    // `prompt` replaces Codex's configured realtime backend instructions and must stay absent.
    expect(start?.params).not.toHaveProperty("prompt");
    expect(diagnostics).toEqual([
      {
        personaId: "bundled-yori",
        status: "accepted",
        appServerVersion: "0.146.0",
        delivery: "initial-items",
        startupContextIncluded: true,
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("persona speaking guidance");
    client.stop();
  });

  it("can explicitly replace the realtime backend prompt for a comparison experiment", async () => {
    const diagnostics: CodexRealtimePersonaApplication[] = [];
    const client = new CodexRealtimeClient("main-session", undefined, {
      getPersonaSnapshot: () => ({ personaId: "yori-ja", instructions: "I am Yori" }),
      personaPromptMode: "replace",
      includeStartupContext: false,
      onPersonaApplication: (application) => diagnostics.push(application),
    });

    await client.start();

    const start = bridge.sent.find((message) => message.method === "thread/realtime/start");
    expect(start?.params?.prompt).toBe("I am Yori");
    expect(start?.params).not.toHaveProperty("initialItems");
    expect(start?.params?.includeStartupContext).toBe(true);
    expect(diagnostics).toEqual([
      {
        personaId: "yori-ja",
        status: "accepted",
        appServerVersion: "0.146.0",
        delivery: "prompt-replacement",
        startupContextIncluded: true,
      },
    ]);
    client.stop();
  });

  it("can omit Codex startup context while keeping persona supplemental", async () => {
    const diagnostics: CodexRealtimePersonaApplication[] = [];
    const client = new CodexRealtimeClient("main-session", undefined, {
      getPersonaSnapshot: () => ({ personaId: "yori-ja", instructions: "I am Yori" }),
      includeStartupContext: false,
      onPersonaApplication: (application) => diagnostics.push(application),
    });

    await client.start();

    const start = bridge.sent.find((message) => message.method === "thread/realtime/start");
    expect(start?.params).toMatchObject({
      includeStartupContext: false,
      initialItems: [{ role: "developer", text: "I am Yori" }],
    });
    expect(start?.params).not.toHaveProperty("prompt");
    expect(diagnostics[diagnostics.length - 1]).toMatchObject({
      delivery: "initial-items",
      startupContextIncluded: false,
    });
    client.stop();
  });

  it("reads a fresh authoritative persona snapshot for each new realtime session", async () => {
    let personaId = "user-a";
    let instructions = "persona A";
    const client = new CodexRealtimeClient("main-session", undefined, {
      getPersonaSnapshot: () => ({ personaId, instructions }),
    });

    await client.start();
    client.stop();
    personaId = "user-b";
    instructions = "persona B";
    await client.start();

    const starts = bridge.sent.filter((message) => message.method === "thread/realtime/start");
    expect(starts.map((message) => message.params?.initialItems)).toEqual([
      [{ role: "developer", text: "persona A" }],
      [{ role: "developer", text: "persona B" }],
    ]);
    client.stop();
  });

  it.each([
    {
      name: "no active persona",
      snapshot: { personaId: null, instructions: "orphaned text" },
      status: "skipped-no-persona",
    },
    {
      name: "empty addition",
      snapshot: { personaId: "quiet", instructions: "  " },
      status: "skipped-empty",
    },
  ] as const)("starts honestly without persona initial items for $name", async ({
    snapshot,
    status,
  }) => {
    const diagnostics: CodexRealtimePersonaApplication[] = [];
    const client = new CodexRealtimeClient("main-session", undefined, {
      getPersonaSnapshot: () => snapshot,
      includeStartupContext: false,
      onPersonaApplication: (application) => diagnostics.push(application),
    });

    await client.start();

    const start = bridge.sent.find((message) => message.method === "thread/realtime/start");
    expect(start?.params).not.toHaveProperty("initialItems");
    expect(start?.params?.includeStartupContext).toBe(true);
    expect(diagnostics[0]?.status).toBe(status);
    client.stop();
  });

  it("falls back without inventing fields when app-server capability is absent", async () => {
    bridge.capabilities = { appServerVersion: "0.145.0", personaInitialItems: false };
    const diagnostics: CodexRealtimePersonaApplication[] = [];
    const client = new CodexRealtimeClient("main-session", undefined, {
      getPersonaSnapshot: () => ({ personaId: "yori", instructions: "persona prompt" }),
      includeStartupContext: false,
      onPersonaApplication: (application) => diagnostics.push(application),
    });

    await client.start();

    const start = bridge.sent.find((message) => message.method === "thread/realtime/start");
    expect(start?.params).not.toHaveProperty("initialItems");
    expect(start?.params).not.toHaveProperty("prompt");
    expect(start?.params?.includeStartupContext).toBe(true);
    expect(JSON.stringify(start?.params)).not.toContain("persona prompt");
    expect(diagnostics).toEqual([
      { personaId: "yori", status: "unsupported", appServerVersion: "0.145.0" },
    ]);
    client.stop();
  });

  it("keeps GPT Live available with prompt-free diagnostics when persona loading fails", async () => {
    const diagnostics: CodexRealtimePersonaApplication[] = [];
    const client = new CodexRealtimeClient("main-session", undefined, {
      getPersonaSnapshot: () => {
        throw new Error("sensitive persona contents");
      },
      includeStartupContext: false,
      onPersonaApplication: (application) => diagnostics.push(application),
    });

    await client.start();

    expect(client.getStatus()).toBe("active");
    const start = bridge.sent.find((message) => message.method === "thread/realtime/start");
    expect(start?.params?.includeStartupContext).toBe(true);
    expect(diagnostics).toEqual([
      { personaId: null, status: "load-failed", appServerVersion: "0.146.0" },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("sensitive");
    client.stop();
  });

  it("passes the configured voice to Codex realtime", async () => {
    const client = new CodexRealtimeClient("main-session", undefined, { voice: "juniper" });

    await client.start();

    expect(
      bridge.sent.find((message) => message.method === "thread/realtime/start")?.params,
    ).toMatchObject({ voice: "juniper" });
    client.stop();
  });

  it.each([
    {
      name: "plain detail",
      rejection: "Field `session.model` is not allowed for this Codex realtime session",
    },
    {
      name: "reported JSON detail",
      rejection:
        '{ "detail": "Field `session.model` is not allowed for this Codex realtime session" }',
    },
  ])("retries with realtime v2 for the exact v3 session.model rejection as $name", async ({
    rejection,
  }) => {
    bridge.realtimeStartVersionErrors = {
      v3: rejection,
    };
    const diagnostics: CodexRealtimePersonaApplication[] = [];
    const voiceFallbacks: CodexRealtimeVoiceFallback[] = [];
    const client = new CodexRealtimeClient("main-session", undefined, {
      getPersonaSnapshot: () => ({ personaId: "yori", instructions: "persona guidance" }),
      includeStartupContext: false,
      getVoiceCandidates: () => ["maple", "sol"],
      onVoiceFallback: (fallback) => voiceFallbacks.push(fallback),
      onPersonaApplication: (application) => diagnostics.push(application),
    });

    await client.start();

    const starts = bridge.sent.filter((message) => message.method === "thread/realtime/start");
    expect(starts).toHaveLength(2);
    expect(starts[0]?.params).toMatchObject({
      threadId: "thread-1",
      outputModality: "audio",
      version: "v3",
      voice: "maple",
      includeStartupContext: false,
      initialItems: [{ role: "developer", text: "persona guidance" }],
      transport: { type: "webrtc", sdp: "local-offer" },
    });
    expect(starts[1]?.params).toEqual({
      threadId: "thread-1",
      outputModality: "audio",
      version: "v2",
      voice: "maple",
      includeStartupContext: true,
      transport: { type: "webrtc", sdp: "local-offer" },
    });
    expect(voiceFallbacks).toEqual([]);
    expect(diagnostics).toEqual([
      { personaId: "yori", status: "unsupported", appServerVersion: "0.146.0" },
    ]);
    expect(client.getStatus()).toBe("active");
    client.stop();
  });

  it("does not downgrade realtime for other v3 start failures", async () => {
    bridge.realtimeStartVersionErrors = {
      v3: "realtime is not enabled for this account",
    };
    const client = new CodexRealtimeClient("main-session");

    await expect(client.start()).rejects.toThrow("realtime is not enabled for this account");

    const starts = bridge.sent.filter((message) => message.method === "thread/realtime/start");
    expect(starts).toHaveLength(1);
    expect(starts[0]?.params?.version).toBe("v3");
    expect(client.getStatus()).toBe("error");
  });

  it("falls back to the next candidate only when the app-server rejects the voice", async () => {
    bridge.realtimeStartErrors = { maple: "Invalid voice: maple" };
    const fallbacks: CodexRealtimeVoiceFallback[] = [];
    const client = new CodexRealtimeClient("main-session", undefined, {
      getVoiceCandidates: () => ["maple", "juniper", "sol"],
      onVoiceFallback: (fallback) => fallbacks.push(fallback),
    });

    await client.start();

    const starts = bridge.sent.filter((message) => message.method === "thread/realtime/start");
    expect(starts.map((message) => message.params?.voice)).toEqual(["maple", "juniper"]);
    expect(fallbacks).toEqual([
      { fromVoice: "maple", toVoice: "juniper", reason: "Invalid voice: maple" },
    ]);
    expect(client.getStatus()).toBe("active");
    client.stop();
  });

  it("falls back through global to the built-in default when both are rejected", async () => {
    bridge.realtimeStartErrors = {
      maple: "unsupported voice",
      juniper: "voice 'juniper' is not supported",
    };
    const fallbacks: CodexRealtimeVoiceFallback[] = [];
    const client = new CodexRealtimeClient("main-session", undefined, {
      getVoiceCandidates: () => ["maple", "juniper", "sol"],
      onVoiceFallback: (fallback) => fallbacks.push(fallback),
    });

    await client.start();

    const starts = bridge.sent.filter((message) => message.method === "thread/realtime/start");
    expect(starts.map((message) => message.params?.voice)).toEqual(["maple", "juniper", "sol"]);
    expect(fallbacks.map((fallback) => fallback.toVoice)).toEqual(["juniper", "sol"]);
    expect(client.getStatus()).toBe("active");
    client.stop();
  });

  it("surfaces the rejection when every candidate voice is refused", async () => {
    bridge.realtimeStartErrors = {
      maple: "unsupported voice",
      sol: "unsupported voice",
    };
    const client = new CodexRealtimeClient("main-session", undefined, {
      getVoiceCandidates: () => ["maple", "sol"],
    });

    await expect(client.start()).rejects.toThrow("unsupported voice");

    expect(client.getStatus()).toBe("error");
  });

  it("does not hide a generic start failure behind voice fallback", async () => {
    bridge.realtimeStartErrors = { maple: "realtime is not enabled for this account" };
    const fallbacks: CodexRealtimeVoiceFallback[] = [];
    const client = new CodexRealtimeClient("main-session", undefined, {
      getVoiceCandidates: () => ["maple", "juniper", "sol"],
      onVoiceFallback: (fallback) => fallbacks.push(fallback),
    });

    await expect(client.start()).rejects.toThrow("realtime is not enabled for this account");

    const starts = bridge.sent.filter((message) => message.method === "thread/realtime/start");
    expect(starts.map((message) => message.params?.voice)).toEqual(["maple"]);
    expect(fallbacks).toEqual([]);
    expect(client.getStatus()).toBe("error");
  });

  it("does not treat a voice-adjacent auth failure as a voice rejection", async () => {
    bridge.realtimeStartErrors = {
      maple: "Voice requires Codex to be signed in with ChatGPT or an API key.",
    };
    const client = new CodexRealtimeClient("main-session", undefined, {
      getVoiceCandidates: () => ["maple", "sol"],
    });

    await expect(client.start()).rejects.toThrow("Voice requires Codex to be signed in");

    expect(
      bridge.sent.filter((message) => message.method === "thread/realtime/start"),
    ).toHaveLength(1);
  });

  it("stops the fallback chain when the attempt is cancelled between candidates", async () => {
    bridge.realtimeStartErrors = { maple: "Invalid voice: maple" };
    const client = new CodexRealtimeClient("main-session", undefined, {
      getVoiceCandidates: () => ["maple", "juniper"],
      onVoiceFallback: () => client.stop(),
    });

    await expect(client.start()).rejects.toThrow(
      "Codex realtime start attempt is no longer active",
    );

    const starts = bridge.sent.filter((message) => message.method === "thread/realtime/start");
    expect(starts.map((message) => message.params?.voice)).toEqual(["maple"]);
    expect(client.getStatus()).toBe("idle");
  });

  it("re-reads voice candidates for every new session start", async () => {
    // persona A → B 切替相当：session をまたぐと候補が読み直される。
    let candidates: ReadonlyArray<string> = ["maple"];
    const client = new CodexRealtimeClient("main-session", undefined, {
      getVoiceCandidates: () => candidates,
    });

    await client.start();
    client.stop();
    candidates = ["vale"];
    await client.start();

    const starts = bridge.sent.filter((message) => message.method === "thread/realtime/start");
    expect(starts.map((message) => message.params?.voice)).toEqual(["maple", "vale"]);
    client.stop();
  });

  it("normalizes duplicate and blank voice candidates before starting", async () => {
    bridge.realtimeStartErrors = { maple: "Invalid voice: maple" };
    const client = new CodexRealtimeClient("main-session", undefined, {
      getVoiceCandidates: () => ["  maple  ", "maple", "", "juniper"],
    });

    await client.start();

    const starts = bridge.sent.filter((message) => message.method === "thread/realtime/start");
    expect(starts.map((message) => message.params?.voice)).toEqual(["maple", "juniper"]);
    client.stop();
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

  it("resolves API-key auth before requesting the microphone", async () => {
    bridge.accountType = "apiKey";
    const states: CodexRealtimeState[] = [];
    const client = new CodexRealtimeClient("main-session", (state) => states.push(state));

    await client.start();

    expect(states).toEqual([
      { status: "connecting" },
      { status: "connecting", billing: "api" },
      { status: "active", billing: "api", microphoneActive: true },
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
    expect(readRealtimeDiagnostics()).toEqual([
      expect.objectContaining({
        attemptId: expect.any(String),
        event: "started",
        stage: "preflight",
      }),
      expect.objectContaining({
        event: "failed",
        stage: "thread-discovery",
        category: "ownership",
        retryDecision: "none",
        terminationRequested: false,
      }),
    ]);
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
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let resolveConnection: ((connectionId: string) => void) | undefined;
    bridge.connectPromise = new Promise((resolve) => {
      resolveConnection = resolve;
    });
    const client = new CodexRealtimeClient("main-session");
    const result = client.start().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.connect).toHaveBeenCalledTimes(1);
    // Three bounded attempts: 15s timeout, then 0.5s / 1.5s backoff.
    await vi.advanceTimersByTimeAsync(47_000);
    expect(await result).toEqual(new Error("Codex app-server connection timed out"));

    resolveConnection?.("late-connection");
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.disconnect).toHaveBeenCalledWith({ connectionId: "late-connection" });
    expect(bridge.connect).toHaveBeenCalledTimes(3);
    expect(client.getStatus()).toBe("error");
  });

  it("cancels a pending transient retry when explicitly stopped", async () => {
    vi.useFakeTimers();
    vi.mocked(ensureAudioContextRunning).mockRejectedValueOnce(
      new Error("network connection failed"),
    );
    const client = new CodexRealtimeClient("main-session");
    const result = client.start().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    expect(client.getStatus()).toBe("connecting");
    expect(ensureAudioContextRunning).toHaveBeenCalledTimes(1);

    client.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBeInstanceOf(Error);
    expect(ensureAudioContextRunning).toHaveBeenCalledTimes(1);
    expect(client.getStatus()).toBe("idle");
  });

  it("deduplicates start calls while a transient retry is pending", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.mocked(ensureAudioContextRunning).mockRejectedValueOnce(
      new Error("network connection failed"),
    );
    const client = new CodexRealtimeClient("main-session");
    const first = client.start();
    const second = client.start();

    await vi.advanceTimersByTimeAsync(500);
    await Promise.all([first, second]);

    expect(ensureAudioContextRunning).toHaveBeenCalledTimes(2);
    expect(bridge.connect).toHaveBeenCalledTimes(1);
    expect(client.getStatus()).toBe("active");
    client.stop();
  });

  it("reuses one persona snapshot across transient connection retries", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.mocked(ensureAudioContextRunning).mockRejectedValueOnce(
      new Error("network connection failed"),
    );
    const getPersonaSnapshot = vi.fn(() => ({
      personaId: "yori-ja",
      instructions: "stable persona snapshot",
    }));
    const diagnostics: CodexRealtimePersonaApplication[] = [];
    const client = new CodexRealtimeClient("main-session", undefined, {
      getPersonaSnapshot,
      onPersonaApplication: (application) => diagnostics.push(application),
    });
    const result = client.start();

    await vi.advanceTimersByTimeAsync(500);
    await result;

    expect(getPersonaSnapshot).toHaveBeenCalledTimes(1);
    const starts = bridge.sent.filter((message) => message.method === "thread/realtime/start");
    expect(starts).toHaveLength(1);
    expect(starts[0]?.params?.initialItems).toEqual([
      { role: "developer", text: "stable persona snapshot" },
    ]);
    expect(diagnostics).toEqual([
      {
        personaId: "yori-ja",
        status: "accepted",
        appServerVersion: "0.146.0",
        delivery: "initial-items",
        startupContextIncluded: true,
      },
    ]);
    client.stop();
  });

  it("sends realtime stop before retrying after an accepted start times out", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    bridge.suppressRealtimeSdp = true;
    const client = new CodexRealtimeClient("main-session");
    const result = client.start().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(47_000);
    expect(await result).toEqual(new Error("Codex realtime SDP answer timed out"));
    expect(bridge.disconnect).toHaveBeenCalledTimes(3);
    for (const call of bridge.disconnect.mock.calls) {
      expect(call[0]).toEqual(
        expect.objectContaining({
          finalMessage: expect.stringContaining('"method":"thread/realtime/stop"'),
        }),
      );
    }
  });

  it("fully tears down an active session after a remote error", async () => {
    const client = new CodexRealtimeClient("main-session");
    await client.start();
    const peer = FakePeerConnection.latest;
    const channel = peer?.channel;

    bridge.channel?.onmessage(
      JSON.stringify({
        method: "thread/realtime/error",
        params: { message: "remote failed token=must-not-be-persisted" },
      }),
    );

    expect(client.getStatus()).toBe("error");
    expect(microphoneTrack.stop).toHaveBeenCalledTimes(1);
    expect(peer?.close).toHaveBeenCalledTimes(1);
    expect(channel?.close).toHaveBeenCalledTimes(1);
    expect(bridge.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "connection-1",
        finalMessage: expect.stringContaining('"method":"thread/realtime/stop"'),
      }),
    );
    expect(JSON.stringify(readRealtimeDiagnostics())).not.toContain("must-not-be-persisted");
  });

  it("fully tears down an active session after peer connection failure", async () => {
    const client = new CodexRealtimeClient("main-session");
    await client.start();
    const peer = FakePeerConnection.latest;
    Object.defineProperty(peer, "connectionState", { configurable: true, value: "failed" });

    peer?.dispatchEvent(new Event("connectionstatechange"));

    expect(client.getStatus()).toBe("error");
    expect(microphoneTrack.stop).toHaveBeenCalledTimes(1);
    expect(peer?.close).toHaveBeenCalledTimes(1);
    expect(bridge.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({
        finalMessage: expect.stringContaining('"method":"thread/realtime/stop"'),
      }),
    );
  });

  it("publishes microphone mute and recovery independently from the live conversation", async () => {
    const states: CodexRealtimeState[] = [];
    const client = new CodexRealtimeClient("main-session", (state) => states.push(state));
    await client.start();

    microphoneTrack.setMuted(true);

    expect(client.getStatus()).toBe("active");
    expect(states[states.length - 1]).toEqual({
      status: "active",
      billing: "subscription",
      microphoneActive: false,
    });
    expect(microphoneTrack.stop).not.toHaveBeenCalled();

    microphoneTrack.setMuted(false);

    expect(states[states.length - 1]).toEqual({
      status: "active",
      billing: "subscription",
      microphoneActive: true,
    });
    client.stop();
  });

  it("tears down the live conversation when its last microphone track ends", async () => {
    const states: CodexRealtimeState[] = [];
    const client = new CodexRealtimeClient("main-session", (state) => states.push(state));
    await client.start();
    const peer = FakePeerConnection.latest;

    microphoneTrack.end();

    expect(client.getStatus()).toBe("error");
    expect(states[states.length - 1]).toEqual({
      status: "error",
      error: "Microphone capture ended",
    });
    expect(peer?.close).toHaveBeenCalledTimes(1);
    expect(bridge.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({
        finalMessage: expect.stringContaining('"method":"thread/realtime/stop"'),
      }),
    );
  });

  it("tears down when the microphone stream reports that capture became inactive", async () => {
    const states: CodexRealtimeState[] = [];
    const client = new CodexRealtimeClient("main-session", (state) => states.push(state));
    await client.start();
    const microphone = (client as unknown as { readonly microphone: FakeMediaStream }).microphone;

    microphone.dispatchEvent(new Event("inactive"));

    expect(client.getStatus()).toBe("error");
    expect(states[states.length - 1]).toEqual({
      status: "error",
      error: "Microphone capture became inactive",
    });
    expect(microphoneTrack.stop).toHaveBeenCalledTimes(1);
  });

  it("removes microphone liveness observers during an explicit stop", async () => {
    const states: CodexRealtimeState[] = [];
    const client = new CodexRealtimeClient("main-session", (state) => states.push(state));
    await client.start();

    client.stop();
    microphoneTrack.setMuted(true);
    microphoneTrack.end();

    expect(client.getStatus()).toBe("idle");
    expect(states[states.length - 1]).toEqual({ status: "idle" });
  });

  it("fails before negotiation when getUserMedia returns no live audio track", async () => {
    microphoneTrack.readyState = "ended";
    const client = new CodexRealtimeClient("main-session");

    await expect(client.start()).rejects.toThrow("Microphone did not provide a live audio track");

    expect(client.getStatus()).toBe("error");
    expect(bridge.sent.some((message) => message.method === "thread/realtime/start")).toBe(false);
    expect(microphoneTrack.stop).toHaveBeenCalledTimes(1);
  });

  it("fully tears down an active session after remote playback setup fails", async () => {
    const client = new CodexRealtimeClient("main-session");
    await client.start();
    const peer = FakePeerConnection.latest;
    vi.mocked(ensureAudioContextRunning).mockRejectedValueOnce(
      new Error("audio playback setup failed"),
    );
    const remoteTrack = new FakeAudioTrack();
    const remoteStream = new FakeMediaStream([remoteTrack]);
    const trackEvent = new Event("track");
    Object.defineProperties(trackEvent, {
      streams: { value: [remoteStream] },
      track: { value: remoteTrack },
    });

    peer?.dispatchEvent(trackEvent);
    await vi.waitFor(() => expect(client.getStatus()).toBe("error"));

    expect(microphoneTrack.stop).toHaveBeenCalledTimes(1);
    expect(remoteTrack.stop).toHaveBeenCalledTimes(1);
    expect(peer?.close).toHaveBeenCalledTimes(1);
    expect(bridge.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({
        finalMessage: expect.stringContaining('"method":"thread/realtime/stop"'),
      }),
    );
  });

  it("applies hot voice volume after the analyser without disabling lip sync", async () => {
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const analyser = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      fftSize: 0,
      smoothingTimeConstant: 0,
      frequencyBinCount: 128,
      getByteFrequencyData: vi.fn(),
      getByteTimeDomainData: vi.fn(),
    };
    const gainParam = {
      value: 1,
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn((value: number) => {
        gainParam.value = value;
      }),
    };
    const outputGain = { connect: vi.fn(), disconnect: vi.fn(), gain: gainParam };
    const audioContext = {
      currentTime: 4,
      destination: {},
      createAnalyser: vi.fn(() => analyser),
      createMediaStreamSource: vi.fn(() => source),
      createGain: vi.fn(() => outputGain),
    } as unknown as AudioContext;
    const client = new CodexRealtimeClient("main-session");
    await client.start();
    vi.mocked(ensureAudioContextRunning).mockResolvedValue(audioContext);
    const remoteTrack = new FakeAudioTrack();
    const remoteStream = new FakeMediaStream([remoteTrack]);
    const trackEvent = new Event("track");
    Object.defineProperties(trackEvent, {
      streams: { value: [remoteStream] },
      track: { value: remoteTrack },
    });

    getVoiceVolumeStore().set(0.3);
    FakePeerConnection.latest?.dispatchEvent(trackEvent);
    await vi.waitFor(() => expect(audioContext.createGain).toHaveBeenCalledOnce());
    expect(gainParam.value).toBe(0.3);
    getVoiceVolumeStore().set(0);

    expect(source.connect).toHaveBeenCalledWith(analyser);
    expect(analyser.connect).toHaveBeenCalledWith(outputGain);
    expect(outputGain.connect).toHaveBeenCalledWith(audioContext.destination);
    expect(gainParam.setValueAtTime).toHaveBeenCalledWith(0, audioContext.currentTime);

    client.stop();
    expect(outputGain.disconnect).toHaveBeenCalledOnce();

    gainParam.setValueAtTime.mockClear();
    getVoiceVolumeStore().set(0.7);
    expect(gainParam.setValueAtTime).not.toHaveBeenCalled();

    await client.start();
    const restartedTrack = new FakeAudioTrack();
    const restartedStream = new FakeMediaStream([restartedTrack]);
    const restartedTrackEvent = new Event("track");
    Object.defineProperties(restartedTrackEvent, {
      streams: { value: [restartedStream] },
      track: { value: restartedTrack },
    });
    FakePeerConnection.latest?.dispatchEvent(restartedTrackEvent);
    await vi.waitFor(() => expect(audioContext.createGain).toHaveBeenCalledTimes(2));

    gainParam.setValueAtTime.mockClear();
    getVoiceVolumeStore().set(0.5);
    expect(gainParam.setValueAtTime).toHaveBeenCalledWith(0.5, audioContext.currentTime);

    client.stop();
    expect(outputGain.disconnect).toHaveBeenCalledTimes(2);
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

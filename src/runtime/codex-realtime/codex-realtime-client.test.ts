// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAudioContextRunning } from "../../core/voice/audio-context";
import type { MouthValues } from "../../core/voice/mouth-values";
import { createWorkStatusLedgerStore } from "../work-status-ledger/work-status-ledger-store";
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
  readonly id?: string | number;
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
  threadReadDetails: {} as Record<string, Record<string, unknown>>,
  threadReadFailures: {} as Record<string, number>,
  threadReconcileReadFailures: {} as Record<string, number>,
  realtimeStartPrelude: null as (() => void) | null,
  diagnosticLog: vi.fn(async () => {}),
  /** voice → error message。entry がある voice の thread/realtime/start を error 応答にする。 */
  realtimeStartErrors: {} as Record<string, string>,
  initializeUserAgent: "codex_cli_rs/0.146.0",
  capabilities: { appServerVersion: "0.146.0", personaInitialItems: true },
  suppressRealtimeSdp: false,
  realtimeSdpSuppressions: 0,
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
        if (
          request.params?.includeTurns === true &&
          typeof threadId === "string" &&
          (bridge.threadReconcileReadFailures[threadId] ?? 0) > 0
        ) {
          bridge.threadReconcileReadFailures[threadId] -= 1;
          queueMicrotask(() => {
            bridge.channel?.onmessage(
              JSON.stringify({ id: request.id, error: { message: "resync unavailable" } }),
            );
          });
          return;
        }
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
        const detail =
          request.params?.includeTurns === true && typeof threadId === "string"
            ? bridge.threadReadDetails[threadId]
            : undefined;
        respond({
          thread: detail ?? {
            id: threadId,
            ...(parentThreadId !== undefined ? { parentThreadId } : {}),
          },
        });
      } else if (request.method === "thread/realtime/start") {
        const voice = request.params?.voice;
        const rejection = typeof voice === "string" ? bridge.realtimeStartErrors[voice] : undefined;
        if (rejection !== undefined) {
          queueMicrotask(() => {
            bridge.channel?.onmessage(
              JSON.stringify({ id: request.id, error: { message: rejection } }),
            );
          });
          return;
        }
        bridge.realtimeStartPrelude?.();
        respond({});
        const suppressSdp = bridge.suppressRealtimeSdp || bridge.realtimeSdpSuppressions-- > 0;
        if (!suppressSdp) {
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
  workStatusDiagnosticLog: bridge.diagnosticLog,
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
    bridge.threadReadDetails = {};
    bridge.initializeUserAgent = "codex_cli_rs/0.146.0";
    bridge.capabilities = { appServerVersion: "0.146.0", personaInitialItems: true };
    vi.mocked(ensureAudioContextRunning).mockReset();
    vi.mocked(ensureAudioContextRunning).mockResolvedValue({} as AudioContext);
    bridge.threadReadFailures = {};
    bridge.threadReconcileReadFailures = {};
    bridge.realtimeStartPrelude = null;
    bridge.diagnosticLog.mockClear();
    bridge.realtimeStartErrors = {};
    bridge.suppressRealtimeSdp = false;
    bridge.realtimeSdpSuppressions = 0;
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

  it("automatically injects a work snapshot and later events", async () => {
    const ledger = createWorkStatusLedgerStore();
    const existing = ledger.create({ summary: "Prepare release" });
    ledger.markRunning(existing.id);
    const client = new CodexRealtimeClient("main-session", undefined, {
      workStatusLedger: ledger,
    });

    await client.start();

    const start = bridge.sent.find((message) => message.method === "thread/realtime/start");
    expect(start?.params?.initialItems).toEqual([
      expect.objectContaining({
        role: "developer",
        text: expect.stringContaining('"summary":"Prepare release"'),
      }),
    ]);
    expect(bridge.diagnosticLog).toHaveBeenCalledWith({
      eventKind: "context-initial-enqueued",
      sessionId: "main-session",
      threadId: "thread-1",
      route: "ledger-context",
      result: "enqueued",
      reason: "session-start-snapshot",
      activeCount: 1,
    });
    expect(
      bridge.sent.filter((message) => message.method === "thread/realtime/appendText"),
    ).toHaveLength(0);

    ledger.complete(existing.id, "All checks passed");
    await vi.waitFor(() => {
      const completedUpdate = bridge.sent.find(
        (message) =>
          message.method === "thread/realtime/appendText" &&
          typeof message.params?.text === "string" &&
          message.params.text.includes('"status":"completed"'),
      );
      expect(completedUpdate).toMatchObject({
        params: {
          threadId: "thread-1",
          role: "developer",
          text: expect.stringContaining('"status":"completed"'),
        },
      });
      expect(bridge.diagnosticLog).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKind: "work-updated",
          workId: existing.id,
          status: "completed",
          activeCount: 0,
        }),
      );
    });
    expect(bridge.diagnosticLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKind: "work-updated",
        sessionId: "main-session",
        threadId: "thread-1",
        workId: existing.id,
        previousStatus: "running",
        status: "completed",
        activeCount: 0,
      }),
    );
    await vi.waitFor(() => {
      expect(bridge.diagnosticLog).toHaveBeenCalledWith({
        eventKind: "context-event-delivered",
        sessionId: "main-session",
        threadId: "thread-1",
        route: "ledger-context",
        result: "delivered",
        reason: "ledger-event",
        activeCount: 0,
      });
    });

    client.stop();
    const appendCount = bridge.sent.filter(
      (message) => message.method === "thread/realtime/appendText",
    ).length;
    ledger.create({ summary: "Must not reach a stopped session" });
    expect(
      bridge.sent.filter((message) => message.method === "thread/realtime/appendText"),
    ).toHaveLength(appendCount);
  });

  it("resyncs work created between the initial snapshot and context subscription", async () => {
    const ledger = createWorkStatusLedgerStore();
    bridge.realtimeStartPrelude = () => {
      const work = ledger.create({ summary: "Created while WebRTC starts" });
      ledger.markRunning(work.id);
    };
    const client = new CodexRealtimeClient("main-session", undefined, {
      workStatusLedger: ledger,
    });

    await client.start();

    const start = bridge.sent.find((message) => message.method === "thread/realtime/start");
    expect(start?.params?.initialItems).toEqual([
      expect.objectContaining({ text: expect.stringContaining('"activeCount":0') }),
    ]);
    expect(
      bridge.sent.find(
        (message) =>
          message.method === "thread/realtime/appendText" &&
          typeof message.params?.text === "string" &&
          message.params.text.includes("Created while WebRTC starts"),
      ),
    ).toBeDefined();
    client.stop();
  });

  it("reconciles a completion that occurred while voice was stopped", async () => {
    const ledger = createWorkStatusLedgerStore();
    const first = new CodexRealtimeClient("main-session", undefined, {
      workStatusLedger: ledger,
    });
    await first.start();
    bridge.channel?.onmessage(
      JSON.stringify({
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "inProgress",
            items: [
              {
                type: "userMessage",
                id: "user-1",
                content: [{ type: "text", text: "Run checks", text_elements: [] }],
              },
            ],
          },
        },
      }),
    );
    expect(ledger.get("work-1")?.status).toBe("running");
    first.stop();

    bridge.threadReadDetails["thread-1"] = {
      id: "thread-1",
      parentThreadId: null,
      status: { type: "idle" },
      turns: [{ id: "turn-1", status: "completed", items: [] }],
    };
    const second = new CodexRealtimeClient("main-session", undefined, {
      workStatusLedger: ledger,
    });
    await second.start();

    expect(ledger.get("work-1")?.status).toBe("completed");
    expect(bridge.diagnosticLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKind: "correlation-resync-delivered",
        result: "delivered",
        reason: "correlation-resync",
        activeCount: 0,
        correlationCount: 1,
      }),
    );
    second.stop();
  });

  it("reconciles a subagent approval resolved while voice was stopped", async () => {
    const ledger = createWorkStatusLedgerStore();
    const first = new CodexRealtimeClient("main-session", undefined, {
      workStatusLedger: ledger,
    });
    await first.start();
    bridge.channel?.onmessage(
      JSON.stringify({
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turn: {
            id: "root-turn",
            status: "inProgress",
            items: [
              {
                type: "userMessage",
                id: "user-1",
                content: [{ type: "text", text: "Review it", text_elements: [] }],
              },
            ],
          },
        },
      }),
    );
    bridge.channel?.onmessage(
      JSON.stringify({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "root-turn",
          item: { type: "collabAgentToolCall", id: "spawn-1", receiverThreadIds: ["child"] },
        },
      }),
    );
    bridge.channel?.onmessage(
      JSON.stringify({
        method: "turn/started",
        params: { threadId: "child", turn: { id: "child-turn", status: "inProgress", items: [] } },
      }),
    );
    bridge.channel?.onmessage(
      JSON.stringify({
        id: "child-approval",
        method: "item/commandExecution/requestApproval",
        params: { threadId: "child", turnId: "child-turn" },
      }),
    );
    expect(ledger.get("work-1")?.status).toBe("approval-required");
    first.stop();

    bridge.threadReadDetails["thread-1"] = {
      id: "thread-1",
      status: { type: "active", activeFlags: [] },
      turns: [{ id: "root-turn", status: "inProgress", items: [] }],
    };
    bridge.threadReadDetails.child = { id: "child", status: { type: "idle" } };
    const second = new CodexRealtimeClient("main-session", undefined, {
      workStatusLedger: ledger,
    });
    await second.start();

    expect(ledger.get("work-1")?.status).toBe("running");
    expect(
      bridge.sent.some(
        (message) => message.method === "thread/read" && message.params?.threadId === "child",
      ),
    ).toBe(true);
    second.stop();
  });

  it("retries reconciliation after a transient thread/read failure", async () => {
    const ledger = createWorkStatusLedgerStore();
    const first = new CodexRealtimeClient("main-session", undefined, {
      workStatusLedger: ledger,
    });
    await first.start();
    bridge.channel?.onmessage(
      JSON.stringify({
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "inProgress",
            items: [
              {
                type: "userMessage",
                id: "user-1",
                content: [{ type: "text", text: "Run checks", text_elements: [] }],
              },
            ],
          },
        },
      }),
    );
    first.stop();

    bridge.threadReadDetails["thread-1"] = {
      id: "thread-1",
      status: { type: "idle" },
      turns: [{ id: "turn-1", status: "completed", items: [] }],
    };
    bridge.threadReconcileReadFailures["thread-1"] = 1;
    const second = new CodexRealtimeClient("main-session", undefined, {
      workStatusLedger: ledger,
    });
    await second.start();
    expect(ledger.get("work-1")?.status).toBe("running");

    await new Promise((resolve) => globalThis.setTimeout(resolve, 1_100));
    expect(ledger.get("work-1")?.status).toBe("completed");
    second.stop();
  });

  it("cancels a stale ledger reconciliation retry before an immediate reconnect", async () => {
    vi.useFakeTimers();
    const ledger = createWorkStatusLedgerStore();
    bridge.threadReconcileReadFailures["thread-1"] = 1;
    const client = new CodexRealtimeClient("main-session", undefined, {
      workStatusLedger: ledger,
    });

    await client.start();
    const failedAttemptReads = bridge.sent.filter(
      (message) => message.method === "thread/read" && message.params?.includeTurns === true,
    ).length;
    expect(failedAttemptReads).toBe(1);

    client.stop();
    await client.start();
    const readsAfterReconnect = bridge.sent.filter(
      (message) => message.method === "thread/read" && message.params?.includeTurns === true,
    ).length;
    expect(readsAfterReconnect).toBe(2);

    // The first session scheduled a retry for +1s. Advancing beyond it must not let that
    // stale timer read into, mutate, or tear down the replacement voice session.
    await vi.advanceTimersByTimeAsync(1_100);
    expect(
      bridge.sent.filter(
        (message) => message.method === "thread/read" && message.params?.includeTurns === true,
      ),
    ).toHaveLength(readsAfterReconnect);
    expect(client.getStatus()).toBe("active");

    client.stop();
  });

  it("refreshes work freshness as time crosses the aging and stale boundaries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const ledger = createWorkStatusLedgerStore();
    const work = ledger.create({ summary: "Long-running review" });
    ledger.markRunning(work.id);
    const client = new CodexRealtimeClient("main-session", undefined, {
      workStatusLedger: ledger,
    });
    await client.start();

    await vi.advanceTimersByTimeAsync(60_001);
    expect(
      bridge.sent.some(
        (message) =>
          message.method === "thread/realtime/appendText" &&
          typeof message.params?.text === "string" &&
          message.params.text.includes('"freshness":"aging"'),
      ),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(240_000);
    expect(
      bridge.sent.some(
        (message) =>
          message.method === "thread/realtime/appendText" &&
          typeof message.params?.text === "string" &&
          message.params.text.includes('"freshness":"stale"'),
      ),
    ).toBe(true);
    expect(bridge.diagnosticLog).toHaveBeenCalledWith({
      eventKind: "freshness-refresh-delivered",
      sessionId: "main-session",
      threadId: "thread-1",
      route: "ledger-context",
      result: "delivered",
      reason: "freshness-boundary",
      activeCount: 1,
      freshness: "stale",
      observedAgeSeconds: 300,
    });
    client.stop();
  });

  it("observes delegated turn and approval events without answering the approval", async () => {
    const ledger = createWorkStatusLedgerStore();
    const client = new CodexRealtimeClient("main-session", undefined, {
      workStatusLedger: ledger,
    });
    await client.start();

    bridge.channel?.onmessage(
      JSON.stringify({
        method: "thread/realtime/itemAdded",
        params: {
          threadId: "thread-1",
          item: {
            type: "handoff_request",
            handoff_id: "handoff-1",
            item_id: "realtime-item-1",
            input_transcript: "Create sample.md",
            active_transcript: [],
          },
        },
      }),
    );
    bridge.channel?.onmessage(
      JSON.stringify({
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "inProgress",
            items: [],
          },
        },
      }),
    );
    bridge.channel?.onmessage(
      JSON.stringify({
        id: "approval-from-server",
        method: "item/fileChange/requestApproval",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "patch-1" },
      }),
    );

    expect(ledger.get("work-1")).toMatchObject({
      summary: "Create sample.md",
      status: "approval-required",
    });
    expect(bridge.diagnosticLog).toHaveBeenCalledWith({
      eventKind: "handoff-observed",
      sessionId: "main-session",
      threadId: "thread-1",
      route: "main-agent-handoff",
      result: "observed",
      reason: "realtime-handoff-request",
      activeCount: 1,
    });
    expect(bridge.sent.some((message) => message.id === "approval-from-server")).toBe(false);

    bridge.channel?.onmessage(
      JSON.stringify({
        method: "serverRequest/resolved",
        params: { threadId: "thread-1", requestId: "approval-from-server" },
      }),
    );
    bridge.channel?.onmessage(
      JSON.stringify({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
      }),
    );

    expect(ledger.get("work-1")?.status).toBe("completed");
    client.stop();
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

  it("combines persona and work status developer initial items", async () => {
    const ledger = createWorkStatusLedgerStore();
    const work = ledger.create({ summary: "Prepare release" });
    ledger.markRunning(work.id);
    const client = new CodexRealtimeClient("main-session", undefined, {
      workStatusLedger: ledger,
      getPersonaSnapshot: () => ({ personaId: "yori", instructions: "persona guidance" }),
    });

    await client.start();

    const start = bridge.sent.find((message) => message.method === "thread/realtime/start");
    expect(start?.params?.initialItems).toEqual([
      { role: "developer", text: "persona guidance" },
      expect.objectContaining({
        role: "developer",
        text: expect.stringContaining('"summary":"Prepare release"'),
      }),
    ]);
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

  it("recovers an SDP timeout with the work ledger enabled and keeps one active publisher", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    bridge.realtimeSdpSuppressions = 1;
    const ledger = createWorkStatusLedgerStore();
    const work = ledger.create({ summary: "Verify the release" });
    ledger.markRunning(work.id);
    let workCreatedDuringFailure: ReturnType<typeof ledger.create> | undefined;
    let startCount = 0;
    bridge.realtimeStartPrelude = () => {
      startCount++;
      if (startCount !== 1) return;
      workCreatedDuringFailure = ledger.create({ summary: "Created during failed negotiation" });
      ledger.markRunning(workCreatedDuringFailure.id);
    };
    const client = new CodexRealtimeClient("main-session", undefined, {
      workStatusLedger: ledger,
    });

    const result = client.start();
    await vi.advanceTimersByTimeAsync(15_500);
    await result;

    expect(client.getStatus()).toBe("active");
    expect(workCreatedDuringFailure).toBeDefined();
    const workDuringFailureId = workCreatedDuringFailure?.id ?? "";
    const starts = bridge.sent.filter((message) => message.method === "thread/realtime/start");
    expect(starts).toHaveLength(2);
    expect(starts).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          initialItems: [expect.objectContaining({ text: expect.stringContaining(work.id) })],
        }),
      }),
      expect.objectContaining({
        params: expect.objectContaining({
          initialItems: [
            expect.objectContaining({
              text: expect.stringContaining(workDuringFailureId),
            }),
          ],
        }),
      }),
    ]);
    expect(JSON.stringify(starts[0]?.params?.initialItems)).not.toContain(workDuringFailureId);
    expect(bridge.disconnect).toHaveBeenCalledTimes(1);
    expect(bridge.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({
        finalMessage: expect.stringContaining('"method":"thread/realtime/stop"'),
      }),
    );

    const beforeCompletion = bridge.sent.filter(
      (message) => message.method === "thread/realtime/appendText",
    ).length;
    ledger.complete(work.id, "verified");
    await vi.advanceTimersByTimeAsync(0);
    const completionMessages = bridge.sent
      .filter((message) => message.method === "thread/realtime/appendText")
      .slice(beforeCompletion)
      .filter(
        (message) =>
          typeof message.params?.text === "string" &&
          message.params.text.includes('"status":"completed"'),
      );
    expect(completionMessages).toHaveLength(1);

    client.stop();
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
    expect(bridge.diagnosticLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKind: "realtime-closed-observed",
        result: "observed",
        reason: "realtime-closed",
        activeCount: undefined,
      }),
    );
  });
});

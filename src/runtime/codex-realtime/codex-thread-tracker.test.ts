// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexThreadTracker } from "./codex-thread-tracker";

interface FakeChannel<T> {
  onmessage: (message: T) => void;
}

interface SentMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

const bridge = vi.hoisted(() => ({
  channel: null as FakeChannel<string> | null,
  sent: [] as SentMessage[],
  loadedThreads: ["thread-1"] as string[],
  turns: {} as Record<string, Array<Record<string, unknown>>>,
  parents: {} as Record<string, string | null>,
  ephemeralThreads: new Set<string>(),
  pendingReads: false,
  turnListFailuresRemaining: 0,
  selectedThread: null as string | null,
  connectFailuresRemaining: 0,
  readResponders: [] as Array<() => void>,
  disconnect: vi.fn(async () => {}),
  connect: vi.fn(async ({ onMessage }: { onMessage: FakeChannel<string> }): Promise<string> => {
    if (bridge.connectFailuresRemaining > 0) {
      bridge.connectFailuresRemaining -= 1;
      throw new Error("connect failed");
    }
    bridge.channel = onMessage;
    return `tracker-connection-${bridge.connect.mock.calls.length}`;
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class<T> {
    onmessage: (message: T) => void = () => {};
  },
}));

vi.mock("../../bindings/tauri-commands", () => ({
  sessionRealtimeConnect: bridge.connect,
  sessionRealtimeDisconnect: bridge.disconnect,
  sessionRealtimeSelectedThread: vi.fn(async () => bridge.selectedThread),
  sessionRealtimeSend: vi.fn(async ({ message }: { message: string }): Promise<void> => {
    const request = JSON.parse(message) as SentMessage;
    bridge.sent.push(request);
    if (request.id === undefined) return;
    const respond = (result: unknown) =>
      queueMicrotask(() => bridge.channel?.onmessage(JSON.stringify({ id: request.id, result })));
    const reject = (message: string) =>
      queueMicrotask(() =>
        bridge.channel?.onmessage(
          JSON.stringify({ id: request.id, error: { code: -32000, message } }),
        ),
      );
    if (request.method === "initialize") {
      respond({});
    } else if (request.method === "thread/loaded/list") {
      respond({ data: bridge.loadedThreads });
    } else if (request.method === "thread/read") {
      const threadId = request.params?.threadId;
      const sendRead = () =>
        respond({
          thread: {
            id: threadId,
            parentThreadId:
              typeof threadId === "string" ? (bridge.parents[threadId] ?? null) : null,
            ephemeral: typeof threadId === "string" && bridge.ephemeralThreads.has(threadId),
          },
        });
      if (bridge.pendingReads) bridge.readResponders.push(sendRead);
      else sendRead();
    } else if (request.method === "thread/turns/list") {
      if (bridge.turnListFailuresRemaining > 0) {
        bridge.turnListFailuresRemaining -= 1;
        reject("history is not materialized");
        return;
      }
      const threadId = request.params?.threadId;
      respond({ data: typeof threadId === "string" ? (bridge.turns[threadId] ?? []) : [] });
    }
  }),
}));

describe("CodexThreadTracker", () => {
  beforeEach(() => {
    bridge.channel = null;
    bridge.sent = [];
    bridge.loadedThreads = ["thread-1"];
    bridge.turns = {};
    bridge.parents = {};
    bridge.ephemeralThreads = new Set();
    bridge.pendingReads = false;
    bridge.turnListFailuresRemaining = 0;
    bridge.selectedThread = null;
    bridge.connectFailuresRemaining = 0;
    bridge.readResponders = [];
    bridge.disconnect.mockClear();
    bridge.connect.mockClear();
  });

  it("uses the sole top-level thread as its startup value", async () => {
    const tracker = new CodexThreadTracker("main-session");

    await tracker.start();

    expect(tracker.getCurrentThreadId()).toBe("thread-1");
    tracker.stop();
  });

  it("polls the matched quick-chat turn and returns its final assistant reply", async () => {
    const responses: Array<{ requestId: string; text: string }> = [];
    const tracker = new CodexThreadTracker("main-session", undefined, (response) =>
      responses.push({ requestId: response.requestId, text: response.text }),
    );
    await tracker.start();

    const requestId = await tracker.trackQuickChatPrompt("こんにちは");
    expect(requestId).not.toBeNull();
    bridge.turns["thread-1"] = [
      {
        id: "turn-quick-chat",
        status: "completed",
        items: [
          { type: "userMessage", content: [{ type: "text", text: "こんにちは" }] },
          { type: "agentMessage", phase: "commentary", text: "確認するね。" },
          { type: "agentMessage", phase: "final_answer", text: "こんにちは、聞こえてるよ。" },
        ],
      },
    ];

    await vi.waitFor(() =>
      expect(responses).toEqual([{ requestId, text: "こんにちは、聞こえてるよ。" }]),
    );
    tracker.stop();
  });

  it("does not reuse an identical quick-chat turn that existed in the baseline", async () => {
    const responses: string[] = [];
    bridge.turns["thread-1"] = [
      {
        id: "old-turn",
        status: "completed",
        items: [
          { type: "userMessage", content: [{ type: "text", text: "同じ質問" }] },
          { type: "agentMessage", phase: "final_answer", text: "古い返答" },
        ],
      },
    ];
    const tracker = new CodexThreadTracker("main-session", undefined, (response) =>
      responses.push(response.text),
    );
    await tracker.start();
    await tracker.trackQuickChatPrompt("同じ質問");

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(responses).toEqual([]);

    bridge.turns["thread-1"] = [
      {
        id: "new-turn",
        status: "completed",
        items: [
          { type: "userMessage", content: [{ type: "text", text: "同じ質問" }] },
          { type: "agentMessage", phase: null, text: "新しい返答" },
        ],
      },
      ...bridge.turns["thread-1"],
    ];
    await vi.waitFor(() => expect(responses).toEqual(["新しい返答"]));
    tracker.stop();
  });

  it("tracks the first turn of a fresh thread when baseline history is not materialized", async () => {
    const responses: string[] = [];
    bridge.turnListFailuresRemaining = 1;
    const tracker = new CodexThreadTracker("main-session", undefined, (response) =>
      responses.push(response.text),
    );
    await tracker.start();
    await tracker.trackQuickChatPrompt("最初の質問");

    bridge.turns["thread-1"] = [
      {
        id: "first-turn",
        startedAt: Date.now() / 1_000,
        status: "completed",
        items: [
          { type: "userMessage", content: [{ type: "text", text: "最初の質問" }] },
          { type: "agentMessage", phase: "final_answer", text: "最初の返答" },
        ],
      },
    ];

    await vi.waitFor(() => expect(responses).toEqual(["最初の返答"]));
    tracker.stop();
  });

  it("tracks a quick-chat steer added to an already running turn", async () => {
    const responses: string[] = [];
    bridge.turns["thread-1"] = [
      {
        id: "running-turn",
        status: "inProgress",
        items: [
          {
            type: "userMessage",
            id: "user-original",
            content: [{ type: "text", text: "先に調べて" }],
          },
        ],
      },
    ];
    const tracker = new CodexThreadTracker("main-session", undefined, (response) =>
      responses.push(response.text),
    );
    await tracker.start();
    await tracker.trackQuickChatPrompt("追加で短く答えて");

    bridge.turns["thread-1"] = [
      {
        id: "running-turn",
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "user-original",
            content: [{ type: "text", text: "先に調べて" }],
          },
          {
            type: "userMessage",
            id: "user-steer",
            content: [{ type: "text", text: "追加で短く答えて" }],
          },
          { type: "agentMessage", phase: "final_answer", text: "短い返答" },
        ],
      },
    ];

    await vi.waitFor(() => expect(responses).toEqual(["短い返答"]));
    tracker.stop();
  });

  it("ignores generic thread starts and follows /clear only after the TUI proxy selects it", async () => {
    const tracker = new CodexThreadTracker("main-session");
    await tracker.start();

    bridge.channel?.onmessage(
      JSON.stringify({
        method: "thread/started",
        params: { thread: { id: "subagent", parentThreadId: "thread-1" } },
      }),
    );
    expect(tracker.getCurrentThreadId()).toBe("thread-1");

    bridge.channel?.onmessage(
      JSON.stringify({
        method: "thread/started",
        params: { thread: { id: "internal-title-thread", parentThreadId: null } },
      }),
    );
    expect(tracker.getCurrentThreadId()).toBe("thread-1");

    bridge.selectedThread = "thread-after-clear";
    await vi.waitFor(() => expect(tracker.getCurrentThreadId()).toBe("thread-after-clear"));
    tracker.stop();
  });

  it("does not infer TUI ownership from a generic top-level status notification", async () => {
    const changes: Array<string | null> = [];
    const tracker = new CodexThreadTracker("main-session", (threadId) => changes.push(threadId));
    await tracker.start();

    bridge.loadedThreads = ["thread-1", "thread-after-resume"];
    bridge.channel?.onmessage(
      JSON.stringify({
        method: "thread/status/changed",
        params: { threadId: "thread-after-resume", status: { type: "idle" } },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(tracker.getCurrentThreadId()).toBe("thread-1");
    expect(changes).toEqual(["thread-1"]);
    tracker.stop();
  });

  it("does not infer TUI ownership when another loaded top-level thread becomes active", async () => {
    bridge.loadedThreads = ["thread-1", "thread-2"];
    const tracker = new CodexThreadTracker("main-session");
    await tracker.start();
    expect(tracker.getCurrentThreadId()).toBeNull();

    bridge.channel?.onmessage(
      JSON.stringify({
        method: "thread/status/changed",
        params: { threadId: "thread-2", status: { type: "idle" } },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tracker.getCurrentThreadId()).toBeNull();

    bridge.channel?.onmessage(
      JSON.stringify({
        method: "thread/status/changed",
        params: { threadId: "thread-2", status: { type: "active", activeFlags: [] } },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tracker.getCurrentThreadId()).toBeNull();
    tracker.stop();
  });

  it("ignores side-fork started and status signals without retargeting active voice", async () => {
    const changes: Array<string | null> = [];
    const tracker = new CodexThreadTracker("main-session", (threadId) => changes.push(threadId));
    await tracker.start();

    bridge.channel?.onmessage(
      JSON.stringify({
        method: "thread/started",
        params: {
          thread: { id: "side-fork", parentThreadId: null, forkedFromId: "thread-1" },
        },
      }),
    );
    bridge.channel?.onmessage(
      JSON.stringify({
        method: "thread/status/changed",
        params: { threadId: "side-fork", status: { type: "active", activeFlags: [] } },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(tracker.getCurrentThreadId()).toBe("thread-1");
    expect(changes).toEqual(["thread-1"]);
    tracker.stop();
  });

  it("tracks a normal fork only when the TUI proxy selects it", async () => {
    bridge.loadedThreads = ["thread-1", "forked-thread"];
    const changes: Array<string | null> = [];
    const tracker = new CodexThreadTracker("main-session", (threadId) => changes.push(threadId));
    await tracker.start();
    expect(tracker.getCurrentThreadId()).toBeNull();

    bridge.selectedThread = "forked-thread";
    await vi.waitFor(() => expect(tracker.getCurrentThreadId()).toBe("forked-thread"));

    expect(changes).toEqual(["forked-thread"]);
    tracker.stop();
  });

  it("tracks an already-loaded /resume target observed by the TUI proxy", async () => {
    bridge.loadedThreads = ["thread-1", "thread-2"];
    const tracker = new CodexThreadTracker("main-session");
    await tracker.start();
    expect(tracker.getCurrentThreadId()).toBeNull();

    bridge.selectedThread = "thread-2";
    await vi.waitFor(() => expect(tracker.getCurrentThreadId()).toBe("thread-2"));
    tracker.stop();
  });

  it("does not switch back when the previous top-level thread later becomes idle", async () => {
    const tracker = new CodexThreadTracker("main-session");
    await tracker.start();
    bridge.selectedThread = "thread-2";
    await vi.waitFor(() => expect(tracker.getCurrentThreadId()).toBe("thread-2"));

    bridge.channel?.onmessage(
      JSON.stringify({
        method: "thread/status/changed",
        params: { threadId: "thread-1", status: { type: "idle" } },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(tracker.getCurrentThreadId()).toBe("thread-2");
    tracker.stop();
  });

  it("ignores a subagent status notification while resolving /resume", async () => {
    bridge.parents.subagent = "thread-1";
    const tracker = new CodexThreadTracker("main-session");
    await tracker.start();

    bridge.channel?.onmessage(
      JSON.stringify({
        method: "thread/status/changed",
        params: { threadId: "subagent", status: { type: "idle" } },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(tracker.getCurrentThreadId()).toBe("thread-1");
    tracker.stop();
  });

  it("does not guess from multiple top-level threads when it missed their start events", async () => {
    bridge.loadedThreads = ["thread-1", "thread-2"];
    const tracker = new CodexThreadTracker("main-session");

    await tracker.start();

    expect(tracker.getCurrentThreadId()).toBeNull();
    tracker.stop();
  });

  it("never selects Codex's ephemeral title-generation thread", async () => {
    bridge.loadedThreads = ["workspace-thread", "title-thread"];
    bridge.ephemeralThreads.add("title-thread");
    const tracker = new CodexThreadTracker("main-session");

    await tracker.start();
    expect(tracker.getCurrentThreadId()).toBe("workspace-thread");

    // Even if an older proxy reports the internal thread, validation must keep the workspace.
    bridge.selectedThread = "title-thread";
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(tracker.getCurrentThreadId()).toBe("workspace-thread");
    tracker.stop();
  });

  it("does not select a generic started thread while startup discovery is in flight", async () => {
    bridge.pendingReads = true;
    const tracker = new CodexThreadTracker("main-session");
    const started = tracker.start();
    await vi.waitFor(() => expect(bridge.readResponders).toHaveLength(1));

    bridge.channel?.onmessage(
      JSON.stringify({
        method: "thread/started",
        params: { thread: { id: "thread-after-clear", parentThreadId: null } },
      }),
    );
    bridge.readResponders.shift()?.();
    await started;

    expect(tracker.getCurrentThreadId()).toBeNull();
    tracker.stop();
  });

  it("reconnects after an unexpected bridge closure", async () => {
    vi.useFakeTimers();
    const tracker = new CodexThreadTracker("main-session");
    await tracker.start();
    expect(tracker.getCurrentThreadId()).toBe("thread-1");
    expect(bridge.connect).toHaveBeenCalledTimes(1);

    bridge.loadedThreads = ["thread-1", "thread-after-clear"];
    bridge.channel?.onmessage(
      JSON.stringify({
        method: "yorishiro/realtime-bridge/closed",
        params: { message: "closed" },
      }),
    );
    await vi.advanceTimersByTimeAsync(250);

    expect(bridge.connect).toHaveBeenCalledTimes(2);
    expect(tracker.getCurrentThreadId()).toBeNull();
    tracker.stop();
    vi.useRealTimers();
  });

  it("starts proxy selection polling after an initial connect failure reconnects", async () => {
    vi.useFakeTimers();
    bridge.connectFailuresRemaining = 1;
    bridge.loadedThreads = ["thread-1", "thread-2"];
    bridge.selectedThread = "thread-2";
    const tracker = new CodexThreadTracker("main-session");

    await expect(tracker.start()).rejects.toThrow("connect failed");
    expect(bridge.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(tracker.getCurrentThreadId()).toBe("thread-2"));

    expect(bridge.connect).toHaveBeenCalledTimes(2);
    tracker.stop();
    vi.useRealTimers();
  });
});

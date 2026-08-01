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
  parents: {} as Record<string, string | null>,
  pendingReads: false,
  selectedThread: null as string | null,
  readResponders: [] as Array<() => void>,
  disconnect: vi.fn(async () => {}),
  connect: vi.fn(async ({ onMessage }: { onMessage: FakeChannel<string> }): Promise<string> => {
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
          },
        });
      if (bridge.pendingReads) bridge.readResponders.push(sendRead);
      else sendRead();
    }
  }),
}));

describe("CodexThreadTracker", () => {
  beforeEach(() => {
    bridge.channel = null;
    bridge.sent = [];
    bridge.loadedThreads = ["thread-1"];
    bridge.parents = {};
    bridge.pendingReads = false;
    bridge.selectedThread = null;
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

  it("tracks the top-level thread started by /clear while ignoring subagents", async () => {
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
        params: { thread: { id: "thread-after-clear", parentThreadId: null } },
      }),
    );
    expect(tracker.getCurrentThreadId()).toBe("thread-after-clear");
    tracker.stop();
  });

  it("tracks the top-level thread loaded by /resume from its status notification", async () => {
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
    await vi.waitFor(() => expect(tracker.getCurrentThreadId()).toBe("thread-after-resume"));

    expect(changes).toEqual(["thread-1", "thread-after-resume"]);
    tracker.stop();
  });

  it("tracks a grace-period loaded /resume target when its next turn becomes active", async () => {
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
    await vi.waitFor(() => expect(tracker.getCurrentThreadId()).toBe("thread-2"));
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
    bridge.channel?.onmessage(
      JSON.stringify({
        method: "thread/started",
        params: { thread: { id: "thread-2", parentThreadId: null } },
      }),
    );

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

  it("does not overwrite a broadcast thread with an older discovery snapshot", async () => {
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

    expect(tracker.getCurrentThreadId()).toBe("thread-after-clear");
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
});

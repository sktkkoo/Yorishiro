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
  readResponders: [] as Array<() => void>,
  disconnect: vi.fn(async () => {}),
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
      return "tracker-connection";
    },
  ),
  sessionRealtimeDisconnect: bridge.disconnect,
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
    bridge.readResponders = [];
    bridge.disconnect.mockClear();
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
});

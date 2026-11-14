// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSessionFollowup } from "./followup-bridge";

interface Rpc {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}
interface MessageChannel {
  onmessage: (raw: string) => void;
}
const fixture = vi.hoisted(() => ({
  channel: null as MessageChannel | null,
  calls: [] as Rpc[],
  order: [] as string[],
  paused: new Set<string>(),
  connection: null as Promise<string> | null,
  connect: vi.fn(async ({ onMessage }: { onMessage: MessageChannel }) => {
    fixture.channel = onMessage;
    return fixture.connection ? await fixture.connection : "helper-connection";
  }),
  disconnect: vi.fn(async ({ connectionId }: { connectionId: string }) => {
    fixture.order.push(`disconnect:${connectionId}`);
  }),
}));

function resultFor(method: string): unknown {
  switch (method) {
    case "initialize":
      return { userAgent: "codex_cli_rs/0.169.0" };
    case "thread/read":
      return {
        thread: {
          id: "main-thread",
          cwd: "/project",
          model: "test-model",
          modelProvider: "same-provider",
        },
      };
    case "config/read":
      return { config: { mcp_servers: {} } };
    case "thread/start":
      return {
        thread: { id: "helper-thread", ephemeral: true },
        model: "test-model",
        modelProvider: "same-provider",
        sandbox: { type: "readOnly" },
      };
    case "turn/start":
      return { turn: { id: "helper-turn" } };
    default:
      return {};
  }
}
function respond(request: Rpc): void {
  fixture.channel?.onmessage(
    JSON.stringify({ id: request.id, result: resultFor(request.method ?? "") }),
  );
}
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (raw: string) => void = () => {};
  },
}));
vi.mock("../../bindings/tauri-commands", () => ({
  sessionRealtimeConnect: fixture.connect,
  sessionRealtimeDisconnect: fixture.disconnect,
  sessionRealtimeSend: vi.fn(
    async ({ connectionId, message }: { connectionId: string; message: string }) => {
      expect(connectionId).toBe("helper-connection");
      const request = JSON.parse(message) as Rpc;
      fixture.calls.push(request);
      fixture.order.push(request.method ?? "reply");
      if (request.id !== undefined && !fixture.paused.has(request.method ?? ""))
        queueMicrotask(() => respond(request));
    },
  ),
}));
async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}
function requestFor(method: string): Rpc {
  const request = fixture.calls.find((call) => call.method === method);
  if (!request) throw new Error(`Missing fixture request: ${method}`);
  return request;
}
function start(signal: AbortSignal) {
  // 早期の失敗にも直ちに handler を付け、未処理 rejection と区別する。
  return generateSessionFollowup(
    "existing-session",
    "main-thread",
    [{ role: "user", text: "旅行の予定を考えたい" }],
    signal,
  ).then(
    (value) => ({ value, error: null }),
    (error: Error) => ({ value: null, error }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  fixture.channel = null;
  fixture.calls.length = 0;
  fixture.order.length = 0;
  fixture.paused.clear();
  fixture.connection = null;
  fixture.connect.mockClear();
  fixture.disconnect.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("isolated follow-up bridge lifecycle", () => {
  it("returns the helper result and unsubscribes without interrupting the visible thread", async () => {
    const result = start(new AbortController().signal);
    await flush();
    requestFor("turn/start");
    fixture.channel?.onmessage(
      JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "helper-thread",
          turnId: "helper-turn",
          item: {
            type: "agentMessage",
            text: JSON.stringify({ speak: true, text: "日程から一緒に考えますか？" }),
          },
        },
      }),
    );
    fixture.channel?.onmessage(
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "helper-thread",
          turn: { id: "helper-turn", status: "completed" },
        },
      }),
    );
    expect(await result).toEqual({
      value: { speak: true, text: "日程から一緒に考えますか？" },
      error: null,
    });
    expect(fixture.calls.some((call) => call.method === "turn/interrupt")).toBe(false);
    expect(requestFor("thread/unsubscribe").params).toEqual({ threadId: "helper-thread" });
    expect(fixture.disconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases a late attachment after cancellation without initializing it", async () => {
    let resolveConnection!: (id: string) => void;
    fixture.connection = new Promise((resolve) => {
      resolveConnection = resolve;
    });
    const controller = new AbortController();
    const result = start(controller.signal);
    controller.abort();
    resolveConnection("cancelled-connection");
    expect((await result).error?.message).toBe("followup_cancelled");
    expect(fixture.calls).toEqual([]);
    expect(fixture.disconnect).toHaveBeenCalledWith({ connectionId: "cancelled-connection" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not attach a bridge for an already cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await start(controller.signal);
    expect(result.error?.message).toBe("followup_cancelled");
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("collects a late helper ID after cancellation before disconnecting, without starting a turn", async () => {
    fixture.paused.add("thread/start");
    const controller = new AbortController();
    const result = start(controller.signal);
    await flush();
    const pending = requestFor("thread/start");
    controller.abort();
    await flush();
    expect(fixture.disconnect).not.toHaveBeenCalled();
    respond(pending);
    const outcome = await result;
    expect(outcome.error?.message).toBe("followup_cancelled");
    expect(fixture.calls.some((call) => call.method === "turn/start")).toBe(false);
    expect(requestFor("thread/unsubscribe").params).toEqual({ threadId: "helper-thread" });
    expect(fixture.order.indexOf("thread/unsubscribe")).toBeLessThan(
      fixture.order.indexOf("disconnect:helper-connection"),
    );
    expect(fixture.disconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("interrupts a late turn ACK and drains cleanup before closing the helper bridge", async () => {
    fixture.paused.add("turn/start");
    const controller = new AbortController();
    const result = start(controller.signal);
    await flush();
    const pending = requestFor("turn/start");
    expect(pending.params?.threadId).toBe("helper-thread");
    controller.abort();
    await flush();
    expect(fixture.disconnect).not.toHaveBeenCalled();
    respond(pending);
    const outcome = await result;
    expect(outcome.error?.message).toBe("followup_cancelled");
    expect(
      fixture.calls.find((call) => call.method === "turn/interrupt" && call.params?.turnId !== "")
        ?.params,
    ).toEqual({
      threadId: "helper-thread",
      turnId: "helper-turn",
    });
    for (const method of ["turn/interrupt", "thread/unsubscribe"]) {
      expect(fixture.order.indexOf(method)).toBeLessThan(
        fixture.order.indexOf("disconnect:helper-connection"),
      );
    }
    expect(
      fixture.calls
        .filter((call) =>
          ["turn/start", "turn/interrupt", "thread/unsubscribe"].includes(call.method ?? ""),
        )
        .every((call) => call.params?.threadId === "helper-thread"),
    ).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "thread/start",
    "turn/start",
  ])("cleans a %s ACK received after its RPC timeout", async (method) => {
    fixture.paused.add(method);
    const controller = new AbortController();
    const result = start(controller.signal);
    await flush();
    const pending = requestFor(method);
    controller.abort();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fixture.disconnect).not.toHaveBeenCalled();
    respond(pending);
    const outcome = await result;
    expect(outcome.error).not.toBeNull();
    if (method === "turn/start") {
      expect(
        fixture.calls.find((call) => call.method === "turn/interrupt" && call.params?.turnId !== "")
          ?.params,
      ).toEqual({
        threadId: "helper-thread",
        turnId: "helper-turn",
      });
      expect(fixture.order.indexOf("turn/interrupt")).toBeLessThan(
        fixture.order.indexOf("thread/unsubscribe"),
      );
    } else expect(fixture.calls.some((call) => call.method === "turn/start")).toBe(false);
    expect(fixture.order.indexOf("thread/unsubscribe")).toBeLessThan(
      fixture.order.indexOf("disconnect:helper-connection"),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it("uses an owned turn notification after cancellation when the ACK is permanently lost", async () => {
    fixture.paused.add("turn/start");
    const controller = new AbortController();
    const result = start(controller.signal);
    await flush();
    controller.abort();
    await vi.advanceTimersByTimeAsync(20_000);
    fixture.channel?.onmessage(
      JSON.stringify({
        method: "turn/started",
        params: { threadId: "helper-thread", turn: { id: "notified-turn" } },
      }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await result).error).not.toBeNull();
    expect(
      fixture.calls.find((call) => call.method === "turn/interrupt" && call.params?.turnId !== "")
        ?.params,
    ).toEqual({
      threadId: "helper-thread",
      turnId: "notified-turn",
    });
    expect(fixture.order.indexOf("turn/interrupt")).toBeLessThan(
      fixture.order.indexOf("thread/unsubscribe"),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it("uses only the source-defined startup interrupt when both ACK and notifications are lost", async () => {
    fixture.paused.add("turn/start");
    const controller = new AbortController();
    const result = start(controller.signal);
    await flush();
    controller.abort();
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await result).error).not.toBeNull();
    expect(fixture.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
    expect(fixture.calls.filter((call) => call.method === "turn/interrupt")).toEqual([
      expect.objectContaining({ params: { threadId: "helper-thread", turnId: "" } }),
    ]);
    expect(requestFor("thread/unsubscribe").params).toEqual({ threadId: "helper-thread" });
    expect(fixture.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects oversized frames before parsing and interrupts the owned helper", async () => {
    const result = start(new AbortController().signal);
    await flush();
    fixture.channel?.onmessage(" ".repeat(262_145));
    expect((await result).error?.message).toBe("followup_cancelled");
    expect(fixture.calls.find((call) => call.method === "turn/interrupt")?.params).toEqual({
      threadId: "helper-thread",
      turnId: "helper-turn",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not begin generation after initialization was cancelled", async () => {
    fixture.paused.add("initialize");
    const controller = new AbortController();
    const result = start(controller.signal);
    await flush();
    controller.abort();
    respond(requestFor("initialize"));
    expect((await result).error?.message).toBe("followup_cancelled");
    expect(fixture.calls.some((call) => call.method === "thread/read")).toBe(false);
    expect(fixture.disconnect).toHaveBeenCalledWith({ connectionId: "helper-connection" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disconnects a connection that arrives after the connection deadline", async () => {
    let resolveConnection!: (id: string) => void;
    fixture.connection = new Promise((resolve) => {
      resolveConnection = resolve;
    });
    const result = start(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await result).error?.message).toBe("followup_connect_timeout");
    expect(fixture.calls).toEqual([]);
    resolveConnection("late-connection");
    await flush();
    expect(fixture.disconnect).toHaveBeenCalledWith({ connectionId: "late-connection" });
    expect(fixture.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a stalled initialize and releases only the new attachment", async () => {
    fixture.paused.add("initialize");
    const result = start(new AbortController().signal);
    await flush();
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await result).error?.message).toBe("followup_rpc_timeout");
    expect(fixture.disconnect).toHaveBeenCalledWith({ connectionId: "helper-connection" });
    expect(fixture.calls.some((call) => call.method === "thread/start")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

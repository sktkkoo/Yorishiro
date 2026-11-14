import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FollowupTransport,
  generateFollowup,
  parseFollowupCandidate,
} from "./temporary-followup";

function fixture() {
  let listener: ((message: Record<string, unknown>) => boolean) | null = null;
  const emit = (method: string, params: object) => listener?.({ method, params });
  const started = {
    thread: { id: "helper", ephemeral: true },
    model: "configured-model",
    modelProvider: "custom-provider",
    sandbox: { type: "readOnly" },
  };
  const request = vi.fn(
    async (method: string, _params: Record<string, unknown>): Promise<unknown> => {
      if (method === "thread/read")
        return {
          thread: {
            id: "main",
            cwd: "/workspace",
            model: "configured-model",
            modelProvider: "custom-provider",
          },
        };
      if (method === "config/read")
        return { config: { mcp_servers: { privateServer: {}, sharedServer: {} } } };
      if (method === "thread/start") return started;
      if (method === "turn/start") return { turn: { id: "turn" } };
      return {};
    },
  );
  const transport: FollowupTransport = {
    request,
    subscribe: (callback) => {
      listener = callback;
      return () => {
        listener = null;
      };
    },
    rejectInteraction: vi.fn(),
  };
  const controller = new AbortController();
  const run = () =>
    generateFollowup(transport, "main", [{ role: "user", text: "colors?" }], controller.signal);
  const finish = (raw = '{"speak":true,"text":"Blue?"}') => {
    emit("item/completed", {
      threadId: "helper",
      turnId: "turn",
      item: { type: "agentMessage", text: raw },
    });
    emit("turn/completed", { threadId: "helper", turn: { id: "turn", status: "completed" } });
  };
  return { request, transport, controller, started, emit, run, finish };
}
const flush = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve();
};
describe("temporary follow-up isolation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("keeps model/provider, disables all effective MCP and tools, and never starts a main turn", async () => {
    const f = fixture();
    const result = f.run();
    await flush();
    f.finish();
    await expect(result).resolves.toEqual({ speak: true, text: "Blue?" });
    const start = f.request.mock.calls.find(([method]) => method === "thread/start")?.[1];
    expect(start).toMatchObject({
      model: "configured-model",
      modelProvider: "custom-provider",
      allowProviderModelFallback: false,
      ephemeral: true,
      environments: [],
      dynamicTools: [],
      selectedCapabilityRoots: [],
      runtimeWorkspaceRoots: [],
      sandbox: "read-only",
      config: {
        "features.shell_tool": false,
        "features.multi_agent": false,
        "features.plugins": false,
        "skills.include_instructions": false,
        "tools.experimental_request_user_input.enabled": false,
        web_search: "disabled",
        mcp_servers: { privateServer: { enabled: false }, sharedServer: { enabled: false } },
      },
    });
    for (const [method, params] of f.request.mock.calls)
      if (method === "turn/start" || method === "turn/interrupt")
        expect(params.threadId).toBe("helper");
    expect(f.request).toHaveBeenCalledWith("thread/unsubscribe", { threadId: "helper" });
  });
  it("fails closed on mismatched provider before any inference", async () => {
    const f = fixture();
    f.started.modelProvider = "other";
    await expect(f.run()).rejects.toThrow("isolation");
    expect(f.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    expect(f.request).toHaveBeenCalledWith("thread/unsubscribe", { threadId: "helper" });
  });
  it("fails closed when effective configuration is unavailable", async () => {
    const f = fixture();
    const original = f.request.getMockImplementation();
    if (!original) throw new Error("fixture missing");
    f.request.mockImplementation(async (method, params) =>
      method === "config/read" ? {} : original(method, params),
    );
    await expect(f.run()).rejects.toThrow("config");
    expect(f.request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
  });
  it("handles completion notifications arriving before turn/start acknowledgement", async () => {
    const f = fixture();
    const original = f.request.getMockImplementation();
    if (!original) throw new Error("fixture missing");
    f.request.mockImplementation(async (method, params) => {
      if (method === "turn/start") f.finish();
      return original(method, params);
    });
    await expect(f.run()).resolves.toEqual({ speak: true, text: "Blue?" });
  });
  it.each([
    "oversized",
    "aggregate",
  ])("bounds early notifications by UTF-8 bytes: %s", async (kind) => {
    const f = fixture();
    const original = f.request.getMockImplementation();
    if (!original) throw new Error("fixture missing");
    f.request.mockImplementation(async (method, params) => {
      if (method === "turn/start") {
        const count = kind === "oversized" ? 1 : 8;
        for (let i = 0; i < count; i++)
          f.emit("item/completed", {
            threadId: "helper",
            turnId: "turn",
            item: { type: "agentMessage", text: "あ".repeat(kind === "oversized" ? 3000 : 2000) },
          });
      }
      return original(method, params);
    });
    await expect(f.run()).rejects.toThrow("cancelled");
    expect(f.request).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "helper",
      turnId: "turn",
    });
  });
  it("rejects unexpected tool activity and interrupts only its helper", async () => {
    const f = fixture();
    const result = f.run();
    const rejected = expect(result).rejects.toThrow("cancelled");
    await flush();
    f.emit("item/started", {
      threadId: "helper",
      turnId: "turn",
      item: { type: "commandExecution" },
    });
    await rejected;
    expect(f.request).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "helper",
      turnId: "turn",
    });
  });
  it("cancels after the deadline without retrying", async () => {
    const f = fixture();
    const result = f.run();
    const rejected = expect(result).rejects.toThrow("cancelled");
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(f.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
  });
  it.each([
    '{"speak":false,"text":"surprise"}',
    '{"speak":true,"text":""}',
    '{"speak":true,"text":"hello","instruction":"bad"}',
    JSON.stringify({ speak: true, text: "あ".repeat(241) }),
  ])("rejects invalid spoken output %s", (raw) => {
    expect(() => parseFollowupCandidate(raw)).toThrow();
  });
});

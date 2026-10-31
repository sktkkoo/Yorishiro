// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatApprovalRequest } from "../bindings/tauri-commands";
import { useChatApprovals } from "./use-chat-approvals";

const bridge = vi.hoisted(() => ({ list: vi.fn(), respond: vi.fn() }));
vi.mock("../bindings/tauri-commands", () => ({
  sessionChatApprovals: bridge.list,
  sessionChatApprovalRespond: bridge.respond,
}));

const request: ChatApprovalRequest = {
  id: "exact-request",
  sessionId: "main",
  agent: "codex",
  conversationId: "thread-A",
  title: "Run command",
  detail: "printf hello",
  choices: [
    { id: "allow", label: "allowOnce", detail: null },
    { id: "deny", label: "deny", detail: null },
  ],
};
const options = {
  enabled: true,
  sessionId: "main",
  agent: "codex",
  generation: 1,
  conversationId: "thread-A",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  bridge.list.mockReset().mockImplementation(async ({ enabled }) => (enabled ? [request] : []));
  bridge.respond.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useChatApprovals", () => {
  it("uses strictly ordered owners when the browser clock repeats across mounts", async () => {
    vi.spyOn(performance, "now").mockReturnValue(100);
    const first = renderHook(() => useChatApprovals(options));
    await act(async () => {});
    first.unmount();
    renderHook(() => useChatApprovals(options));
    await act(async () => {});
    const owners = bridge.list.mock.calls
      .filter(([args]) => args.enabled)
      .map(([args]) => Number(args.ownerId.split(":")[0]));
    expect(owners).toHaveLength(2);
    expect(owners[1]).toBeGreaterThan(owners[0]);
  });

  it("lists only the current provider/session/conversation and never decides automatically", async () => {
    bridge.list.mockResolvedValue([
      request,
      { ...request, id: "other-session", sessionId: "shell" },
      { ...request, id: "other-agent", agent: "claude" },
      { ...request, id: "other-thread", conversationId: "thread-B" },
    ]);
    const { result } = renderHook(() => useChatApprovals(options));
    await act(async () => {});
    expect(result.current.requests).toEqual([request]);
    expect(bridge.respond).not.toHaveBeenCalled();
  });

  it("responds once with exact request and owner, and suppresses stale polled copies", async () => {
    const response = deferred<void>();
    bridge.respond.mockReturnValue(response.promise);
    const { result } = renderHook(() => useChatApprovals(options));
    await act(async () => {});
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.respond(request.id, "allow");
    });
    act(() => {
      void result.current.respond(request.id, "deny");
    });
    expect(bridge.respond).toHaveBeenCalledTimes(1);
    expect(bridge.respond).toHaveBeenCalledWith({
      sessionId: "main",
      ownerId: bridge.list.mock.calls[0][0].ownerId,
      id: request.id,
      decision: "allow",
    });
    expect(result.current.busyIds).toEqual([request.id]);
    await act(async () => {
      response.resolve();
      await pending;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.requests).toEqual([]);
    expect(result.current.busyIds).toEqual([]);
  });

  it("rejects unsupported decisions and IDs without transport calls", async () => {
    bridge.list.mockResolvedValue([
      { ...request, choices: [{ id: "deny", label: "deny", detail: null }] },
    ]);
    const { result } = renderHook(() => useChatApprovals(options));
    await act(async () => {});
    await act(async () => {
      await result.current.respond(request.id, "allow");
      await result.current.respond(request.id, "allowSession");
      await result.current.respond(request.id, "invented-rule-id");
      await result.current.respond("another-request", "deny");
    });
    expect(bridge.respond).not.toHaveBeenCalled();
  });

  it("forwards only the exact offered choice ID without interpreting a persistent rule", async () => {
    const ruleId = "native-rule-choice-19";
    bridge.list.mockResolvedValue([
      {
        ...request,
        choices: [
          ...request.choices,
          { id: ruleId, label: "allowRule", detail: "prefix: [npm, test]" },
        ],
      },
    ]);
    const { result } = renderHook(() => useChatApprovals(options));
    await act(async () => {});
    await act(async () => {
      await result.current.respond(request.id, "allowRule");
      await result.current.respond(request.id, "prefix: [npm, test]");
    });
    expect(bridge.respond).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.respond(request.id, ruleId);
    });
    expect(bridge.respond).toHaveBeenCalledExactlyOnceWith({
      sessionId: "main",
      ownerId: bridge.list.mock.calls[0][0].ownerId,
      id: request.id,
      decision: ruleId,
    });
  });

  it("rejects a formerly offered choice after the current request options change", async () => {
    const sessionChoice = { id: "session-choice", label: "allowSession", detail: "This session" };
    bridge.list.mockResolvedValueOnce([
      { ...request, choices: [...request.choices, sessionChoice] },
    ]);
    const { result } = renderHook(() => useChatApprovals(options));
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await result.current.respond(request.id, sessionChoice.id);
    });
    expect(bridge.respond).not.toHaveBeenCalled();
  });

  it("releases the lease and blocks an old callback immediately after leaving Chat", async () => {
    const { result, rerender } = renderHook((props) => useChatApprovals(props), {
      initialProps: options,
    });
    await act(async () => {});
    const oldRespond = result.current.respond;
    const ownerId = bridge.list.mock.calls[0][0].ownerId;
    rerender({ ...options, enabled: false });
    await act(async () => {
      await oldRespond(request.id, "allow");
    });
    expect(result.current.requests).toEqual([]);
    expect(bridge.respond).not.toHaveBeenCalled();
    expect(bridge.list).toHaveBeenCalledWith({ sessionId: "main", ownerId, enabled: false });
  });

  it("ignores results from an earlier A→B→A activation", async () => {
    const old = deferred<ChatApprovalRequest[]>();
    bridge.list.mockReturnValueOnce(old.promise);
    const { result, rerender } = renderHook((props) => useChatApprovals(props), {
      initialProps: options,
    });
    rerender({ ...options, conversationId: "thread-B" });
    rerender(options);
    await act(async () => {});
    expect(result.current.requests).toEqual([request]);
    await act(async () => {
      old.resolve([{ ...request, id: "stale" }]);
    });
    expect(result.current.requests).toEqual([request]);
  });

  it("keeps failed decisions visible without automatically retrying", async () => {
    bridge.respond.mockRejectedValue(new Error("disconnected"));
    const { result } = renderHook(() => useChatApprovals(options));
    await act(async () => {});
    await act(async () => {
      await result.current.respond(request.id, "deny");
    });
    expect(result.current.error).toBe("respond");
    expect(result.current.requests).toEqual([request]);
    expect(result.current.busyIds).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(bridge.respond).toHaveBeenCalledTimes(1);
  });

  it("hides stale cards when polling fails and recovers on the next heartbeat", async () => {
    const { result } = renderHook(() => useChatApprovals(options));
    await act(async () => {});
    bridge.list.mockRejectedValueOnce(new Error("connection lost"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.requests).toEqual([]);
    expect(result.current.error).toBe("read");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.requests).toEqual([request]);
    expect(result.current.error).toBeNull();
  });
});

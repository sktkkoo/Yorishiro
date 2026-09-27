// @vitest-environment jsdom
import { listen } from "@tauri-apps/api/event";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sessionRealtimeSelectedThreadState } from "../bindings/tauri-commands";
import { useClaudeScreenSharing } from "./use-claude-screen-sharing";

const mocks = vi.hoisted(() => ({
  transports: [] as {
    owner: unknown;
    stop: ReturnType<typeof vi.fn>;
    observe: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock("../bindings/tauri-commands", () => ({ sessionRealtimeSelectedThreadState: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("./claude-screen-observation", () => ({
  ClaudeScreenObservationTransport: class {
    stop = vi.fn();
    observe = vi.fn(async () => ({ status: "shared", capturedAt: "now" }));
    constructor(readonly owner: unknown) {
      mocks.transports.push(this);
    }
  },
}));
const listeners = new Map<string, (event: { payload: unknown }) => void>();
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  listeners.clear();
  mocks.transports.length = 0;
  vi.mocked(listen).mockImplementation(async (name, callback) => {
    listeners.set(name, callback as (event: { payload: unknown }) => void);
    return () => {
      listeners.delete(name);
    };
  });
  vi.mocked(sessionRealtimeSelectedThreadState).mockResolvedValue({
    sessionId: "claude-a",
    confirmed: true,
    revision: 1,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

it("leaves the native Claude transport inactive for Codex or an unavailable agent", async () => {
  const { result } = renderHook(() =>
    useClaudeScreenSharing({ available: false, sessionId: "main" }),
  );
  await settle();
  expect(result.current.available).toBe(false);
  expect(sessionRealtimeSelectedThreadState).not.toHaveBeenCalled();
  expect(mocks.transports).toHaveLength(0);
});

it("waits for a confirmed conversation and scopes the transport to its revision", async () => {
  vi.mocked(sessionRealtimeSelectedThreadState).mockResolvedValueOnce({
    sessionId: "draft",
    confirmed: false,
    revision: 0,
  });
  const { result } = renderHook(() =>
    useClaudeScreenSharing({ available: true, sessionId: "main" }),
  );
  await settle();
  expect(result.current.available).toBe(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(result.current.available).toBe(true);
  expect(mocks.transports[mocks.transports.length - 1]?.owner).toEqual({
    sessionId: "main",
    conversationId: "claude-a",
    revision: 1,
  });
});

it("stops old sharing on conversation replacement and on agent switching", async () => {
  const { result, rerender } = renderHook(
    ({ available }) => useClaudeScreenSharing({ available, sessionId: "main" }),
    { initialProps: { available: true } },
  );
  await settle();
  const old = mocks.transports[0];
  const oldKey = result.current.ownerKey;
  vi.mocked(sessionRealtimeSelectedThreadState).mockResolvedValue({
    sessionId: "claude-b",
    confirmed: true,
    revision: 2,
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(old.stop).toHaveBeenCalled();
  expect(result.current.ownerKey).not.toBe(oldKey);
  const current = mocks.transports[mocks.transports.length - 1];
  rerender({ available: false });
  expect(result.current.available).toBe(false);
  expect(current?.stop).toHaveBeenCalled();
});

it("does not resurrect an exited Claude from a stale selection snapshot", async () => {
  const { result } = renderHook(() =>
    useClaudeScreenSharing({ available: true, sessionId: "main" }),
  );
  await settle();
  act(() => listeners.get("pty-exit")?.({ payload: { session_id: "main" } }));
  expect(result.current.available).toBe(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(result.current.available).toBe(false);
  expect(sessionRealtimeSelectedThreadState).toHaveBeenCalledOnce();
});

it("ignores callbacks queued by listeners from a replaced host session", async () => {
  const { result, rerender } = renderHook(
    ({ sessionId }) => useClaudeScreenSharing({ available: true, sessionId }),
    { initialProps: { sessionId: "old-host" } },
  );
  await settle();
  const oldHook = listeners.get("hook-signal");
  const oldExit = listeners.get("pty-exit");
  rerender({ sessionId: "new-host" });
  await settle();
  const current = mocks.transports[mocks.transports.length - 1];
  act(() => {
    oldHook?.({
      payload: JSON.stringify({ sessionId: "old-host", agent: "claude", event: "session-end" }),
    });
    oldExit?.({ payload: { session_id: "old-host" } });
  });
  expect(result.current.available).toBe(true);
  expect(current.stop).not.toHaveBeenCalled();
});

it("ignores a late SessionEnd from a previous conversation in the same host", async () => {
  const { result } = renderHook(() =>
    useClaudeScreenSharing({ available: true, sessionId: "main" }),
  );
  await settle();
  act(() =>
    listeners.get("hook-signal")?.({
      payload: JSON.stringify({
        sessionId: "main",
        session_id: "previous-conversation",
        agent: "claude",
        event: "session-end",
      }),
    }),
  );
  expect(result.current.available).toBe(true);
  expect(mocks.transports[0].stop).not.toHaveBeenCalled();
});

it("ignores other sessions and invalidates on matching Claude SessionEnd", async () => {
  const { result } = renderHook(() =>
    useClaudeScreenSharing({ available: true, sessionId: "main" }),
  );
  await settle();
  act(() =>
    listeners.get("hook-signal")?.({
      payload: JSON.stringify({ sessionId: "other", agent: "claude", event: "session-end" }),
    }),
  );
  expect(result.current.available).toBe(true);
  act(() =>
    listeners.get("hook-signal")?.({
      payload: JSON.stringify({ sessionId: "main", agent: "claude", event: "session-end" }),
    }),
  );
  expect(result.current.available).toBe(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(result.current.available).toBe(false);
});

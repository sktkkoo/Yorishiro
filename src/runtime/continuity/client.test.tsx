// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContinuityContext, ContinuitySnapshot } from "./types";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  callback: null as null | ((event: { payload: ContinuitySnapshot }) => void),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
const context: ContinuityContext = {
  personaId: "yori-ja",
  personaName: "Yori",
  personaPrompt: "Curious",
  language: "ja",
  cwd: null,
};
function snapshot(personaId = "yori-ja", revision = 1): ContinuitySnapshot {
  return {
    personaId,
    autoEnabled: true,
    revision,
    phase: "idle",
    messages: [],
    understandings: [],
    drafts: [],
    reflections: [],
    error: null,
    lastObservedAt: 1,
  };
}
function pendingSnapshot() {
  let resolve!: (value: ContinuitySnapshot) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<ContinuitySnapshot>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetModules();
  native.invoke.mockReset();
  native.listen.mockReset();
  native.callback = null;
  native.invoke.mockImplementation(async (_command, args) =>
    snapshot(args?.context?.personaId ?? args?.personaId ?? "yori-ja"),
  );
  native.listen.mockImplementation(async (_event, callback) => {
    native.callback = callback;
    return vi.fn();
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("shared continuity bridge", () => {
  it.each([
    "status",
    "retry",
  ] as const)("does not restore an obsolete wait from a delayed %s response at the same revision", async (source) => {
    const client = await import("./client");
    const waiting: ContinuitySnapshot = {
      ...snapshot("yori-ja", 5),
      phase: "error",
      error: "Worker unavailable",
      automaticRetryAt: 1000,
      publicationSequence: 10,
    };
    native.invoke.mockResolvedValue(waiting);
    const view = renderHook(({ cwd }) => client.useContinuity({ ...context, cwd }, false), {
      initialProps: { cwd: "/before" },
    });
    await waitFor(() => expect(view.result.current.snapshot).toEqual(waiting));
    const request = pendingSnapshot();
    native.invoke.mockReturnValueOnce(request.promise);
    let completion: Promise<void> | undefined;
    if (source === "status") view.rerender({ cwd: "/after" });
    else
      act(() => {
        completion = client.retryContinuity(context);
      });
    await waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(2));
    const released = { ...waiting, automaticRetryAt: null, publicationSequence: 12 };
    act(() => native.callback?.({ payload: released }));
    expect(view.result.current.snapshot).toEqual(released);
    native.invoke.mockRejectedValueOnce(new Error("Message could not be saved"));
    await act(async () => {
      await client.sendContinuityMessage(context, "Keep this request").catch(() => undefined);
    });
    await act(async () => {
      request.resolve({ ...waiting, publicationSequence: 11 });
      await completion;
    });
    expect(view.result.current.snapshot).toEqual(released);
    expect(view.result.current.error).toBe("Message could not be saved");
    const scheduledAgain = { ...waiting, automaticRetryAt: 2000, publicationSequence: 14 };
    act(() => native.callback?.({ payload: scheduledAgain }));
    act(() => native.callback?.({ payload: { ...released, publicationSequence: 13 } }));
    expect(view.result.current.snapshot).toEqual(scheduledAgain);
  });

  it("keeps saved revision primary and accepts legacy or unorderable equal-revision publications", async () => {
    const client = await import("./client");
    const initial = { ...snapshot("yori-ja", 5), publicationSequence: 10 };
    native.invoke.mockResolvedValue(initial);
    const view = renderHook(() => client.useContinuity(context, false));
    await waitFor(() => expect(view.result.current.snapshot).toEqual(initial));
    act(() =>
      native.callback?.({ payload: { ...initial, revision: 4, publicationSequence: 100 } }),
    );
    expect(view.result.current.snapshot).toEqual(initial);
    const newerRevision = { ...initial, revision: 6, publicationSequence: 1 };
    act(() => native.callback?.({ payload: newerRevision }));
    expect(view.result.current.snapshot).toEqual(newerRevision);
    for (const publicationSequence of [
      undefined,
      NaN,
      Infinity,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const valid = { ...newerRevision, publicationSequence: 10 };
      act(() => native.callback?.({ payload: valid }));
      const unorderable = { ...newerRevision, publicationSequence };
      act(() => native.callback?.({ payload: unorderable }));
      expect(view.result.current.snapshot).toEqual(unorderable);
      act(() => native.callback?.({ payload: newerRevision }));
      expect(view.result.current.snapshot).toEqual(newerRevision);
    }
    native.invoke.mockRejectedValueOnce(new Error("Work retry failed"));
    await act(async () => {
      await client.retryContinuity(context).catch(() => undefined);
    });
    expect(view.result.current.error).toBe("Work retry failed");
    act(() => native.callback?.({ payload: newerRevision }));
    expect(view.result.current.error).toBeNull();
  });

  it.each([
    false,
    true,
  ])("ignores a superseded workspace refresh failure while open is %s", async (open) => {
    const client = await import("./client");
    const oldRequest = pendingSnapshot();
    const latest = { ...snapshot("yori-ja", 7), autoEnabled: false };
    native.invoke.mockImplementation((_command, args) =>
      args.context.cwd === "/old" ? oldRequest.promise : Promise.resolve(latest),
    );
    const view = renderHook(({ cwd }) => client.useContinuity({ ...context, cwd }, open), {
      initialProps: { cwd: "/old" },
    });
    await waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(1));
    view.rerender({ cwd: "/new" });
    await waitFor(() => expect(view.result.current.snapshot).toEqual(latest));
    await act(async () => oldRequest.reject(new Error("Old workspace is unavailable")));
    expect(view.result.current.snapshot).toEqual(latest);
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.errorSource).toBeNull();
    expect(native.invoke).toHaveBeenCalledTimes(2);
  });

  it("preserves the current sync error when an obsolete request fails later", async () => {
    const client = await import("./client");
    const oldRequest = pendingSnapshot();
    native.invoke.mockImplementation((_command, args) =>
      args.context.cwd === "/old"
        ? oldRequest.promise
        : Promise.reject(new Error("Current workspace could not sync")),
    );
    const view = renderHook(({ cwd }) => client.useContinuity({ ...context, cwd }, false), {
      initialProps: { cwd: "/old" },
    });
    await waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(1));
    view.rerender({ cwd: "/new" });
    await waitFor(() => expect(view.result.current.error).toBe("Current workspace could not sync"));
    expect(view.result.current.errorSource).toBe("sync");
    await act(async () => oldRequest.reject(new Error("Obsolete failure")));
    expect(view.result.current.error).toBe("Current workspace could not sync");
    expect(view.result.current.errorSource).toBe("sync");
  });

  it("does not repopulate the shared error after a refresh owner unmounts", async () => {
    const client = await import("./client");
    const request = pendingSnapshot();
    native.invoke.mockReturnValueOnce(request.promise);
    const oldView = renderHook(() => client.useContinuity(context, false));
    await waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(1));
    oldView.unmount();
    await act(async () => request.reject(new Error("Unmounted refresh failed")));
    native.invoke.mockReturnValueOnce(pendingSnapshot().promise);
    const reopened = renderHook(() => client.useContinuity(context, false));
    expect(reopened.result.current.error).toBeNull();
    expect(reopened.result.current.errorSource).toBeNull();
  });

  it.each([
    3, 9,
  ])("still accepts native snapshots by revision when an old refresh returns revision %s", async (revision) => {
    const client = await import("./client");
    const oldRequest = pendingSnapshot();
    const latest = { ...snapshot("yori-ja", 7), autoEnabled: false };
    native.invoke.mockImplementation((_command, args) =>
      args.context.cwd === "/old" ? oldRequest.promise : Promise.resolve(latest),
    );
    const view = renderHook(({ cwd }) => client.useContinuity({ ...context, cwd }, false), {
      initialProps: { cwd: "/old" },
    });
    await waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(1));
    view.rerender({ cwd: "/new" });
    await waitFor(() => expect(view.result.current.snapshot?.revision).toBe(7));
    const completed = { ...snapshot("yori-ja", revision), autoEnabled: false };
    await act(async () => oldRequest.resolve(completed));
    expect(view.result.current.snapshot?.revision).toBe(Math.max(7, revision));
    act(() => native.callback?.({ payload: snapshot("yori-ja", 12) }));
    expect(view.result.current.snapshot?.revision).toBe(12);
    act(() => native.callback?.({ payload: snapshot("yori-ja", 11) }));
    expect(view.result.current.snapshot?.revision).toBe(12);
  });

  it.each([
    "send",
    "autonomy",
  ] as const)("preserves a pending manual %s failure across a workspace change", async (source) => {
    const client = await import("./client");
    const oldContext = { ...context, cwd: "/old" };
    const view = renderHook(({ cwd }) => client.useContinuity({ ...context, cwd }, false), {
      initialProps: { cwd: "/old" },
    });
    await waitFor(() => expect(view.result.current.snapshot?.revision).toBe(1));
    const request = pendingSnapshot();
    native.invoke.mockReturnValueOnce(request.promise);
    const operation =
      source === "send"
        ? client.sendContinuityMessage(oldContext, "User's actual message")
        : client.setContinuityAutoEnabled(oldContext, false);
    const rejected = expect(operation).rejects.toThrow("Manual operation failed");
    await waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(2));
    view.rerender({ cwd: "/new" });
    await waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(3));
    await act(async () => {
      request.reject(new Error("Manual operation failed"));
      await rejected;
    });
    expect(view.result.current.error).toBe("Manual operation failed");
    expect(view.result.current.errorSource).toBe(source);
    act(() => native.callback?.({ payload: snapshot("yori-ja", 2) }));
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.errorSource).toBeNull();
  });

  it("reports a current automatic tick failure as work, then a focus refresh failure as sync", async () => {
    const client = await import("./client");
    vi.useFakeTimers();
    const view = renderHook(() => client.useContinuity(context, true));
    await act(async () => {});
    native.invoke.mockRejectedValueOnce(new Error("Automatic work could not start"));
    await act(async () => vi.advanceTimersByTimeAsync(5 * 60 * 1000));
    expect(view.result.current.error).toBe("Automatic work could not start");
    expect(view.result.current.errorSource).toBe("work");
    native.invoke.mockRejectedValueOnce(new Error("Could not refresh current state"));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(view.result.current.error).toBe("Could not refresh current state");
    expect(view.result.current.errorSource).toBe("sync");
  });

  it.each([
    "send",
    "draft",
    "forget",
    "autonomy",
    "observation",
    "work",
    "sync",
  ] as const)("preserves the %s error source until an acknowledged snapshot arrives", async (source) => {
    const client = await import("./client");
    const view = renderHook(() => client.useContinuity(context, false));
    await waitFor(() => expect(view.result.current.snapshot?.revision).toBe(1));
    const operations = {
      send: () => client.sendContinuityMessage(context, "Unsent text", "memory-1"),
      draft: () => client.actOnContinuityDraft(context, "draft-1", "continue"),
      forget: () => client.forgetContinuityUnderstanding(context, "memory-1"),
      autonomy: () => client.setContinuityAutoEnabled(context, false),
      observation: () =>
        client.observeContinuityExchange(context, {
          userText: "Voice message",
          assistantText: "",
          sourceKey: "voice-1",
        }),
      work: () => client.retryContinuity(context),
      sync: () => client.refreshContinuity(context),
    };
    native.invoke.mockRejectedValueOnce(new Error("Operation failed"));
    await act(async () => {
      await expect(operations[source]()).rejects.toThrow("Operation failed");
    });
    expect(view.result.current.errorSource).toBe(source);
    expect(view.result.current.error).toBe("Operation failed");
    act(() => native.callback?.({ payload: snapshot("yori-ja", 2) }));
    expect(view.result.current.errorSource).toBeNull();
    expect(view.result.current.error).toBeNull();
  });

  it("reloads status through context sync without sending a retry or changing Off", async () => {
    const client = await import("./client");
    native.invoke.mockResolvedValue({ ...snapshot(), autoEnabled: false });
    const view = renderHook(() => client.useContinuity(context, false));
    await waitFor(() => expect(view.result.current.snapshot?.autoEnabled).toBe(false));
    native.invoke.mockClear();
    await act(() => client.refreshContinuity(context));
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("continuity_sync_context", { context });
    expect(view.result.current.snapshot?.autoEnabled).toBe(false);
  });

  it.each([
    "work",
    "sync",
    "autonomy",
  ] as const)("publishes a manual %s bridge failure before invocation and recovers on a later accepted command", async (source) => {
    native.listen.mockRejectedValueOnce(new Error("Initial subscription failed"));
    const client = await import("./client");
    const view = renderHook(() => client.useContinuity(context, false));
    await waitFor(() => expect(view.result.current.error).toBe("Initial subscription failed"));
    const operation = () =>
      source === "work"
        ? client.retryContinuity(context)
        : source === "sync"
          ? client.refreshContinuity(context)
          : client.setContinuityAutoEnabled(context, false);
    native.listen.mockRejectedValueOnce(new Error("Recovery subscription failed"));
    await act(async () => {
      await expect(operation()).rejects.toThrow("Recovery subscription failed");
    });
    expect(native.invoke).not.toHaveBeenCalled();
    expect(view.result.current.error).toBe("Recovery subscription failed");
    expect(view.result.current.errorSource).toBe(source);
    await act(operation);
    expect(native.listen).toHaveBeenCalledTimes(3);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.errorSource).toBeNull();
    expect(view.result.current.snapshot?.revision).toBe(1);
  });

  it.each([
    "work",
    "sync",
  ] as const)("keeps %s failure through older events, then exposes accepted native errors and clears on an equal-revision acknowledgement", async (source) => {
    const client = await import("./client");
    native.invoke.mockResolvedValue({ ...snapshot("yori-ja", 5), autoEnabled: false });
    const view = renderHook(() => client.useContinuity(context, false));
    await waitFor(() => expect(view.result.current.snapshot?.revision).toBe(5));
    const operation = () =>
      source === "work" ? client.retryContinuity(context) : client.refreshContinuity(context);
    native.invoke.mockRejectedValueOnce(new Error("Recovery failed"));
    await act(async () => {
      await expect(operation()).rejects.toThrow("Recovery failed");
    });
    act(() => native.callback?.({ payload: snapshot("yori-ja", 4) }));
    expect(view.result.current.error).toBe("Recovery failed");
    expect(view.result.current.errorSource).toBe(source);
    const accepted = {
      ...snapshot("yori-ja", 6),
      phase: "error" as const,
      error: "New native failure",
    };
    act(() => native.callback?.({ payload: accepted }));
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.snapshot?.error).toBe("New native failure");
    native.invoke.mockRejectedValueOnce(new Error("Another recovery failed"));
    await act(async () => {
      await expect(operation()).rejects.toThrow("Another recovery failed");
    });
    act(() => native.callback?.({ payload: snapshot("yori-ja", 6) }));
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.errorSource).toBeNull();
    expect(view.result.current.snapshot?.error).toBeNull();
  });

  it("forgets the exact memory through native persistence and only accepts the acknowledged snapshot", async () => {
    const client = await import("./client");
    const view = renderHook(() => client.useContinuity(context, false));
    await waitFor(() => expect(view.result.current.snapshot?.revision).toBe(1));
    native.invoke.mockRejectedValueOnce(new Error("Could not save deletion"));
    await act(async () => {
      await expect(client.forgetContinuityUnderstanding(context, "memory-1")).rejects.toThrow(
        "Could not save deletion",
      );
    });
    expect(view.result.current.snapshot?.revision).toBe(1);
    expect(view.result.current.error).toBe("Could not save deletion");
    const acknowledged = {
      ...snapshot("yori-ja", 2),
      forgottenUnderstandings: [
        { understandingId: "memory-1", sourceIds: ["user-1"], forgottenAt: 100 },
      ],
    };
    native.invoke.mockResolvedValueOnce(acknowledged);
    await act(() => client.forgetContinuityUnderstanding(context, "memory-1"));
    expect(native.invoke).toHaveBeenLastCalledWith("continuity_forget_understanding", {
      context,
      understandingId: "memory-1",
    });
    expect(view.result.current.snapshot).toEqual(acknowledged);
    expect(view.result.current.error).toBeNull();
    view.unmount();
  });

  it("stops automatic timers while Off, keeps context sync, and explicitly enables through native", async () => {
    const client = await import("./client");
    vi.useFakeTimers();
    let latest: ContinuitySnapshot = { ...snapshot(), autoEnabled: false, nextStep: "Old work" };
    native.invoke.mockImplementation(async (name, args) => {
      if (name === "continuity_set_auto_enabled") {
        latest = { ...latest, revision: 3, autoEnabled: args.enabled, nextStep: null };
      }
      return latest;
    });
    const view = renderHook(({ open }) => client.useContinuity(context, open), {
      initialProps: { open: true },
    });
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(30 * 60 * 1000));
    expect(native.invoke.mock.calls.some(([name]) => /advance|tick/.test(name))).toBe(false);
    await act(async () => view.rerender({ open: false }));
    await act(async () => view.rerender({ open: true }));
    expect(view.result.current.snapshot?.autoEnabled).toBe(false);
    await act(() => client.setContinuityAutoEnabled(context, true));
    expect(native.invoke).toHaveBeenLastCalledWith("continuity_set_auto_enabled", {
      context,
      enabled: true,
    });
    await act(async () => vi.advanceTimersByTimeAsync(5 * 60 * 1000));
    expect(native.invoke).toHaveBeenLastCalledWith("continuity_tick", { context });
    act(() => native.callback?.({ payload: { ...latest, revision: 4, autoEnabled: false } }));
    const count = native.invoke.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(30 * 60 * 1000));
    expect(native.invoke).toHaveBeenCalledTimes(count);
    view.unmount();
  });

  it("keeps the selected execution backend while its session is not ready", async () => {
    const client = await import("./client");
    const view = renderHook(
      ({ backend, session }: { backend: "codex" | "text"; session: string | null }) =>
        client.useContinuity(
          { ...context, executionBackend: backend, executionSessionId: session },
          false,
        ),
      { initialProps: { backend: "codex" as "codex" | "text", session: null as string | null } },
    );
    await act(async () => {});
    expect(native.invoke).toHaveBeenLastCalledWith("continuity_sync_context", {
      context: { ...context, executionBackend: "codex", executionSessionId: null },
    });
    await act(async () => view.rerender({ backend: "codex", session: "main-ready" }));
    expect(native.invoke).toHaveBeenLastCalledWith("continuity_sync_context", {
      context: { ...context, executionBackend: "codex", executionSessionId: "main-ready" },
    });
    await act(async () => view.rerender({ backend: "text", session: null }));
    expect(native.invoke).toHaveBeenLastCalledWith("continuity_sync_context", {
      context: { ...context, executionBackend: "text", executionSessionId: null },
    });
    view.unmount();
  });

  it("binds automatic work to the current Main session and updates it on replacement", async () => {
    const client = await import("./client");
    vi.useFakeTimers();
    const view = renderHook(
      ({ executionSessionId }: { executionSessionId: string | null }) =>
        client.useContinuity({ ...context, executionSessionId }, true),
      { initialProps: { executionSessionId: "main-original" as string | null } },
    );
    await act(async () => {});
    expect(native.invoke).toHaveBeenCalledWith("continuity_enter", {
      context: { ...context, executionSessionId: "main-original" },
    });
    await act(async () => view.rerender({ executionSessionId: "main-replacement" }));
    await act(async () => vi.advanceTimersByTimeAsync(5 * 60 * 1000));
    expect(native.invoke).toHaveBeenLastCalledWith("continuity_tick", {
      context: { ...context, executionSessionId: "main-replacement" },
    });
    await act(async () => view.rerender({ executionSessionId: null }));
    expect(native.invoke).toHaveBeenLastCalledWith("continuity_enter", {
      context: { ...context, executionSessionId: null },
    });
    view.unmount();
  });

  it.each([
    "thinking",
    "working",
  ] as const)("waits during %s, advances completed work immediately, then quietly waits", async (phase) => {
    const client = await import("./client");
    vi.useFakeTimers();
    let latest = snapshot();
    native.invoke.mockImplementation(async (name) => {
      if (name === "continuity_advance") {
        latest = { ...latest, revision: latest.revision + 1, phase };
      }
      return latest;
    });
    const view = renderHook(() => client.useContinuity(context, true));
    await act(async () => {});
    const advances = () =>
      native.invoke.mock.calls.filter(([name]) => name === "continuity_advance");
    const ticks = () => native.invoke.mock.calls.filter(([name]) => name === "continuity_tick");
    latest = { ...latest, revision: 2, nextStep: "Draft the complete opening experience" };
    act(() => native.callback?.({ payload: latest }));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(advances()).toEqual([["continuity_advance", { context, revision: 2 }]]);
    expect(view.result.current.snapshot?.phase).toBe(phase);
    await act(async () => vi.advanceTimersByTimeAsync(30 * 60 * 1000));
    expect(advances()).toHaveLength(1);
    expect(ticks()).toHaveLength(0);

    latest = {
      ...latest,
      revision: 4,
      phase: "idle",
      nextStep: "Review the draft against the feedback",
    };
    act(() => native.callback?.({ payload: latest }));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(advances()).toHaveLength(2);
    expect(advances()[1]).toEqual(["continuity_advance", { context, revision: 4 }]);
    latest = { ...latest, revision: 6, phase: "idle", nextStep: null };
    act(() => native.callback?.({ payload: latest }));
    await act(async () => vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1));
    expect(ticks()).toHaveLength(0);
    expect(advances()).toHaveLength(2);
    expect(view.result.current.snapshot?.messages).toEqual([]);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(ticks()).toHaveLength(1);
    view.unmount();
  });

  it("does not spin on a duplicate completion or advance an unchanged revision again", async () => {
    const client = await import("./client");
    vi.useFakeTimers();
    const ready = { ...snapshot(), nextStep: "Review the actual draft" };
    native.invoke.mockResolvedValue(ready);
    const view = renderHook(() => client.useContinuity(context, true));
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(0));
    act(() => {
      native.callback?.({ payload: ready });
      native.callback?.({ payload: ready });
    });
    await act(async () => vi.advanceTimersByTimeAsync(60 * 1000));
    expect(native.invoke.mock.calls.filter(([name]) => name === "continuity_advance")).toHaveLength(
      1,
    );
    view.unmount();
  });

  it("keeps completed steps pending while closed and resumes them when reopened", async () => {
    const client = await import("./client");
    vi.useFakeTimers();
    let latest: ContinuitySnapshot = { ...snapshot(), phase: "thinking" };
    native.invoke.mockImplementation(async (name) => {
      if (name === "continuity_advance") {
        latest = { ...latest, phase: "thinking", revision: latest.revision + 1 };
      }
      return latest;
    });
    const view = renderHook(({ open }) => client.useContinuity(context, open), {
      initialProps: { open: true },
    });
    await act(async () => {});
    await act(async () => view.rerender({ open: false }));
    latest = { ...latest, phase: "idle", revision: 2, nextStep: "Continue the saved draft" };
    act(() => native.callback?.({ payload: latest }));
    await act(async () => vi.advanceTimersByTimeAsync(30 * 60 * 1000));
    expect(
      native.invoke.mock.calls.some(
        ([name]) => name === "continuity_advance" || name === "continuity_tick",
      ),
    ).toBe(false);
    await act(async () => view.rerender({ open: true }));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(native.invoke).toHaveBeenCalledWith("continuity_advance", { context, revision: 2 });
    view.unmount();
  });

  it("drops an unsent advance on close and clears an old step when newer foreground work begins", async () => {
    const client = await import("./client");
    vi.useFakeTimers();
    let latest = snapshot();
    native.invoke.mockImplementation(async () => latest);
    const view = renderHook(({ open }) => client.useContinuity(context, open), {
      initialProps: { open: true },
    });
    await act(async () => {});
    latest = { ...latest, revision: 2, nextStep: "An obsolete next step" };
    act(() => native.callback?.({ payload: latest }));
    act(() => {
      vi.advanceTimersByTime(0);
      view.rerender({ open: false });
    });
    await act(async () => {});
    expect(native.invoke.mock.calls.some(([name]) => name === "continuity_advance")).toBe(false);
    await act(async () => view.rerender({ open: true }));
    latest = { ...latest, revision: 3, phase: "thinking", nextStep: null };
    act(() => native.callback?.({ payload: latest }));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(native.invoke.mock.calls.some(([name]) => name === "continuity_advance")).toBe(false);
    view.unmount();
  });

  it("pauses immediate followups while hidden and resumes pending work when visible", async () => {
    const client = await import("./client");
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let latest = snapshot();
    native.invoke.mockImplementation(async (name) => {
      if (name === "continuity_advance")
        latest = { ...latest, revision: latest.revision + 1, phase: "thinking" };
      return latest;
    });
    const view = renderHook(() => client.useContinuity(context, true));
    await act(async () => {});
    visibility.mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    latest = { ...latest, revision: 2, nextStep: "Continue without announcing routine progress" };
    act(() => native.callback?.({ payload: latest }));
    await act(async () => vi.advanceTimersByTimeAsync(30 * 60 * 1000));
    expect(
      native.invoke.mock.calls.some(
        ([name]) => name === "continuity_advance" || name === "continuity_tick",
      ),
    ).toBe(false);
    visibility.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(native.invoke).toHaveBeenCalledWith("continuity_advance", { context, revision: 2 });
    expect(native.invoke.mock.calls.filter(([name]) => name === "continuity_enter")).toHaveLength(
      1,
    );
    view.unmount();
  });

  it("rechecks quiet results after five minutes only while open", async () => {
    const client = await import("./client");
    vi.useFakeTimers();
    const view = renderHook(({ open }) => client.useContinuity(context, open), {
      initialProps: { open: false },
    });
    await act(async () => {});
    expect(native.invoke).toHaveBeenCalledWith("continuity_sync_context", { context });
    const ticks = () => native.invoke.mock.calls.filter(([name]) => name === "continuity_tick");
    await act(async () => vi.advanceTimersByTimeAsync(90 * 60 * 1000));
    expect(ticks()).toHaveLength(0);
    expect(native.invoke.mock.calls.some(([name]) => name === "continuity_enter")).toBe(false);

    await act(async () => view.rerender({ open: true }));
    await act(async () => vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1));
    expect(ticks()).toHaveLength(0);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(ticks()).toHaveLength(1);
    expect(ticks()[0]).toEqual(["continuity_tick", { context }]);
    await act(async () => vi.advanceTimersByTimeAsync(5 * 60 * 1000));
    expect(ticks()).toHaveLength(2);

    await act(async () => view.rerender({ open: false }));
    await act(async () => vi.advanceTimersByTimeAsync(90 * 60 * 1000));
    expect(ticks()).toHaveLength(2);
    await act(async () => view.rerender({ open: true }));
    expect(ticks()).toHaveLength(2);
    await act(async () => vi.advanceTimersByTimeAsync(5 * 60 * 1000));
    expect(ticks()).toHaveLength(3);
    view.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(60 * 60 * 1000));
    expect(ticks()).toHaveLength(3);
  });

  it("keeps the quiet deadline across focus sync, including a sync that finishes after it", async () => {
    const client = await import("./client");
    vi.useFakeTimers();
    const view = renderHook(() => client.useContinuity(context, true));
    await act(async () => {});
    const ticks = () => native.invoke.mock.calls.filter(([name]) => name === "continuity_tick");
    await act(async () => vi.advanceTimersByTimeAsync(4 * 60 * 1000));
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => vi.advanceTimersByTimeAsync(60 * 1000));
    expect(ticks()).toHaveLength(1);

    await act(async () => vi.advanceTimersByTimeAsync(4 * 60 * 1000));
    let finishSync: ((value: ContinuitySnapshot) => void) | undefined;
    native.invoke.mockImplementationOnce(
      () =>
        new Promise<ContinuitySnapshot>((resolve) => {
          finishSync = resolve;
        }),
    );
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => vi.advanceTimersByTimeAsync(2 * 60 * 1000));
    expect(ticks()).toHaveLength(1);
    await act(async () => finishSync?.(snapshot()));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(ticks()).toHaveLength(2);
    view.unmount();
  });

  it("discards an unsent tick when the screen closes and never catches up on focus", async () => {
    const client = await import("./client");
    vi.useFakeTimers();
    const view = renderHook(({ open }) => client.useContinuity(context, open), {
      initialProps: { open: true },
    });
    await act(async () => {});
    // The timer fired, but ensureBridge has not yielded back to its continuation.
    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000);
      view.rerender({ open: false });
    });
    await act(async () => {});
    expect(native.invoke.mock.calls.some(([name]) => name === "continuity_tick")).toBe(false);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(native.invoke).toHaveBeenLastCalledWith("continuity_sync_context", { context });
    view.unmount();
  });

  it("skips hidden windows and replaces the timer when the persona changes", async () => {
    const client = await import("./client");
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const view = renderHook(({ current }) => client.useContinuity(current, true), {
      initialProps: { current: context },
    });
    await act(async () => {});
    visibility.mockReturnValue("hidden");
    await act(async () => vi.advanceTimersByTimeAsync(60 * 60 * 1000));
    expect(native.invoke.mock.calls.some(([name]) => name === "continuity_tick")).toBe(false);
    visibility.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(native.invoke.mock.calls.some(([name]) => name === "continuity_tick")).toBe(false);
    const another = { ...context, personaId: "another" };
    await act(async () => view.rerender({ current: another }));
    await act(async () => vi.advanceTimersByTimeAsync(5 * 60 * 1000));
    expect(native.invoke.mock.calls.filter(([name]) => name === "continuity_tick")).toEqual([
      ["continuity_tick", { context: another }],
    ]);
    view.unmount();
  });

  it("shares built-in language changes without mixing a custom yori persona and ignores stale responses", async () => {
    const client = await import("./client");
    const builtIn = renderHook(() => client.useContinuity(context, true));
    await waitFor(() => expect(builtIn.result.current.snapshot?.revision).toBe(1));
    act(() => native.callback?.({ payload: snapshot("yori-en", 5) }));
    expect(builtIn.result.current.snapshot?.revision).toBe(5);
    act(() => native.callback?.({ payload: snapshot("yori-ja", 2) }));
    expect(builtIn.result.current.snapshot?.revision).toBe(5);
    act(() => native.callback?.({ payload: snapshot("yori", 9) }));
    expect(builtIn.result.current.snapshot?.revision).toBe(5);
    builtIn.unmount();
    const english = renderHook(() =>
      client.useContinuity({ ...context, personaId: "yori-en", language: "en" }, true),
    );
    expect(english.result.current.snapshot?.revision).toBe(5);
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith("continuity_enter", {
        context: expect.objectContaining({ personaId: "yori-en" }),
      }),
    );
    english.unmount();
  });
  it("refreshes on focus without cancelling accepted work when the surface unmounts", async () => {
    const client = await import("./client");
    const view = renderHook(() => client.useContinuity(context, true));
    await waitFor(() => expect(view.result.current.snapshot).not.toBeNull());
    const initialCalls = native.invoke.mock.calls.length;
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(native.invoke.mock.calls.length).toBeGreaterThan(initialCalls));
    await act(() => client.sendContinuityMessage(context, "A correction", "preference"));
    expect(native.invoke).toHaveBeenCalledWith("continuity_send", {
      context,
      text: "A correction",
      correctionId: "preference",
    });
    view.unmount();
    native.callback?.({ payload: snapshot("yori-ja", 7) });
    const reopened = renderHook(() => client.useContinuity(context, true));
    expect(reopened.result.current.snapshot?.revision).toBe(7);
    expect(native.invoke.mock.calls.some(([command]) => /cancel|pause|stop/.test(command))).toBe(
      false,
    );
    reopened.unmount();
  });

  it("receives native background progress while closed and hidden without a frontend wakeup", async () => {
    const client = await import("./client");
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let latest = snapshot();
    native.invoke.mockImplementation(async () => latest);
    const view = renderHook(({ open }) => client.useContinuity(context, open), {
      initialProps: { open: true },
    });
    await act(async () => {});
    await act(async () => view.rerender({ open: false }));
    visibility.mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    // Native owns continuation now: it can finish one step and start another
    // without a visible React surface invoking advance or tick.
    for (const [revision, phase] of [
      [2, "working"],
      [3, "idle"],
      [4, "working"],
    ] as const) {
      latest = { ...latest, revision, phase };
      act(() => native.callback?.({ payload: latest }));
      expect(view.result.current.snapshot?.revision).toBe(revision);
      expect(view.result.current.snapshot?.phase).toBe(phase);
    }
    await act(async () => vi.advanceTimersByTimeAsync(15 * 60 * 1000));
    expect(
      native.invoke.mock.calls.some(([name]) => /advance|tick|cancel|pause|stop/.test(name)),
    ).toBe(false);
    visibility.mockReturnValue("visible");
    await act(async () => view.rerender({ open: true }));
    expect(view.result.current.snapshot?.revision).toBe(4);
    view.unmount();
  });

  it("recovers a failed event subscription through retry and forwards real exchanges", async () => {
    native.listen.mockRejectedValueOnce(new Error("Event bridge unavailable"));
    const client = await import("./client");
    const view = renderHook(() => client.useContinuity(context, true));
    await waitFor(() => expect(view.result.current.error).toContain("Event bridge unavailable"));
    await act(() => client.retryContinuity(context));
    expect(native.listen).toHaveBeenCalledTimes(2);
    expect(view.result.current.error).toBeNull();
    const exchange = {
      userText: "Please remember why",
      assistantText: "The integration work was the problem",
      sourceKey: "thread:turn:1",
    };
    await act(() => client.observeContinuityExchange(context, exchange));
    expect(native.invoke).toHaveBeenCalledWith("continuity_observe_native", {
      context,
      ...exchange,
    });
    view.unmount();
  });

  it("records voice fragments in arrival order across built-in language aliases", async () => {
    const client = await import("./client");
    const first = pendingSnapshot();
    const second = pendingSnapshot();
    native.invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const exchange = (sourceKey: string) => ({ userText: sourceKey, assistantText: "", sourceKey });
    const one = client.observeContinuityExchange(context, exchange("one"));
    const two = client.observeContinuityExchange(
      { ...context, personaId: "yori-en", language: "en" },
      exchange("two"),
    );
    expect(native.invoke).toHaveBeenCalledTimes(1);
    first.resolve(snapshot("yori-ja", 1));
    await one;
    await waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(2));

    // 最初の完了で、新しい待機列の末尾まで削除してはいけない。
    const three = client.observeContinuityExchange(context, exchange("three"));
    await Promise.resolve();
    expect(native.invoke).toHaveBeenCalledTimes(2);
    second.resolve(snapshot("yori-en", 2));
    await Promise.all([two, three]);
    expect(native.invoke.mock.calls.map(([name, args]) => [name, args.sourceKey])).toEqual([
      ["continuity_observe_native", "one"],
      ["continuity_observe_native", "two"],
      ["continuity_observe_native", "three"],
    ]);
  });

  it("does not make another persona wait for an outstanding voice observation", async () => {
    const client = await import("./client");
    const pending = pendingSnapshot();
    native.invoke.mockReturnValueOnce(pending.promise);
    const exchange = { userText: "First", assistantText: "", sourceKey: "voice:one" };
    const first = client.observeContinuityExchange(context, exchange);
    const customContext = { ...context, personaId: "yori" };
    await client.observeContinuityExchange(customContext, exchange);
    expect(native.invoke).toHaveBeenCalledTimes(2);
    expect(native.invoke).toHaveBeenLastCalledWith("continuity_observe_native", {
      context: customContext,
      ...exchange,
    });
    pending.resolve(snapshot());
    await first;
  });

  it("reports a failed observation, continues queued fragments, and releases the idle queue", async () => {
    const client = await import("./client");
    const pending = pendingSnapshot();
    native.invoke.mockReturnValueOnce(pending.promise);
    const exchange = (sourceKey: string) => ({ userText: sourceKey, assistantText: "", sourceKey });
    const first = client.observeContinuityExchange(context, exchange("failed"));
    const rejected = expect(first).rejects.toThrow("Could not save");
    const second = client.observeContinuityExchange(context, exchange("next"));
    expect(native.invoke).toHaveBeenCalledTimes(1);
    pending.reject(new Error("Could not save"));
    await rejected;
    await second;
    expect(native.invoke).toHaveBeenCalledTimes(2);

    // 完了済み Promise を保存し続けず、次の単独観測は直ちに開始できる。
    const third = client.observeContinuityExchange(context, exchange("later"));
    expect(native.invoke).toHaveBeenCalledTimes(3);
    await third;
    expect(native.invoke.mock.calls.map(([, args]) => args.sourceKey)).toEqual([
      "failed",
      "next",
      "later",
    ]);
  });
});

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
});

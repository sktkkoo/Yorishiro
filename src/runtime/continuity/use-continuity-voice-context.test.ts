// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContinuitySnapshot } from "./types";
import { useContinuityVoiceContext } from "./use-continuity-voice-context";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  callbacks: [] as Array<(event: { payload: ContinuitySnapshot }) => void>,
  stops: [] as Array<ReturnType<typeof vi.fn>>,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
vi.mock("../../core/global-prompt/continuity-fragment", () => ({
  continuityPrompt: (snapshot: ContinuitySnapshot) => JSON.stringify(snapshot.messages),
}));

function snapshot(personaId: string, revision: number, text: string): ContinuitySnapshot {
  return {
    personaId,
    revision,
    phase: "idle",
    messages: [{ id: "m", role: "user", content: text, createdAt: 1, source: "conversation" }],
    understandings: [],
    drafts: [],
    reflections: [],
    error: null,
    lastObservedAt: 1,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  native.invoke.mockReset();
  native.listen.mockReset();
  native.callbacks = [];
  native.stops = [];
  native.invoke.mockImplementation(async (_command, { personaId }) =>
    snapshot(personaId, 1, "Initial context"),
  );
  native.listen.mockImplementation(async (_event, callback) => {
    native.callbacks.push(callback);
    const stop = vi.fn();
    native.stops.push(stop);
    return stop;
  });
});

describe("continuity updates in an active voice session", () => {
  it("stays passive while voice is idle and ignores stale reads and unrelated personas", async () => {
    const initial = deferred<ContinuitySnapshot>();
    native.invoke.mockReturnValue(initial.promise);
    const prepareContext = vi.fn(async () => {});
    const onError = vi.fn();
    const view = renderHook(
      ({ active }) =>
        useContinuityVoiceContext({ personaId: "yori-ja", active, prepareContext, onError }),
      { initialProps: { active: false } },
    );
    expect(native.listen).not.toHaveBeenCalled();
    view.rerender({ active: true });
    await waitFor(() => expect(native.invoke).toHaveBeenCalledOnce());
    act(() => native.callbacks[0]({ payload: snapshot("yori-en", 3, "Newest context") }));
    expect(prepareContext).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Newest"));
    await act(() => initial.resolve(snapshot("yori-ja", 1, "Stale context")));
    act(() => native.callbacks[0]({ payload: snapshot("yori", 5, "Custom persona") }));
    act(() => native.callbacks[0]({ payload: snapshot("yori-ja", 4, "Newest context") }));
    expect(prepareContext).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    view.unmount();
    expect(native.stops[0]).toHaveBeenCalledOnce();
  });

  it("revokes callbacks and delayed reads when the persona changes or voice stops", async () => {
    const initial = deferred<ContinuitySnapshot>();
    native.invoke.mockReturnValueOnce(initial.promise);
    const prepareContext = vi.fn(async () => {});
    const onError = vi.fn();
    const view = renderHook(
      ({ personaId, active }) =>
        useContinuityVoiceContext({ personaId, active, prepareContext, onError }),
      { initialProps: { personaId: "yori-ja", active: true } },
    );
    await waitFor(() => expect(native.invoke).toHaveBeenCalledOnce());
    view.rerender({ personaId: "custom", active: true });
    await waitFor(() => expect(prepareContext).toHaveBeenCalledOnce());
    await act(() => initial.resolve(snapshot("yori-ja", 2, "Former owner")));
    act(() => native.callbacks[0]({ payload: snapshot("yori-ja", 3, "Former owner event") }));
    expect(prepareContext).toHaveBeenCalledTimes(1);
    view.rerender({ personaId: "custom", active: false });
    act(() => native.callbacks[1]({ payload: snapshot("custom", 2, "Stopped session") }));
    expect(prepareContext).toHaveBeenCalledTimes(1);
    expect(native.stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
    view.unmount();
  });

  it("reports refresh failures only for the still-active owner", async () => {
    const delivery = deferred<void>();
    const prepareContext = vi.fn(() => delivery.promise);
    const onError = vi.fn();
    const view = renderHook(() =>
      useContinuityVoiceContext({ personaId: "yori-ja", active: true, prepareContext, onError }),
    );
    await waitFor(() => expect(prepareContext).toHaveBeenCalledOnce());
    const failure = new Error("Context delivery failed");
    prepareContext.mockRejectedValueOnce(failure);
    await act(async () => native.callbacks[0]({ payload: snapshot("yori-ja", 2, "Updated") }));
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    view.unmount();
    await act(() => delivery.resolve());
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

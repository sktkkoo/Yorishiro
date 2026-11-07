// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_VOICE_CONTINUITY_UTF8_BYTES } from "../../core/global-prompt/voice-continuity";
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

  it("bounds a huge history update without mutating evidence or repeating phase-only refreshes", async () => {
    const prepareContext = vi.fn(async (_text: string) => {});
    const onError = vi.fn();
    const view = renderHook(() =>
      useContinuityVoiceContext({ personaId: "yori-ja", active: true, prepareContext, onError }),
    );
    await waitFor(() => expect(prepareContext).toHaveBeenCalledOnce());
    const huge: ContinuitySnapshot = {
      ...snapshot("yori-ja", 2, ""),
      messages: Array.from({ length: 40 }, (_, index) => ({
        id: `evidence-${index}`,
        role: "user" as const,
        content: `記録${index}の先頭 ${"日本語の作業履歴😀🧑🏽‍💻".repeat(400)} 新しい優先事項${index}`,
        source: "conversation" as const,
        createdAt: index + 1,
      })),
    };
    const original = JSON.stringify(huge);
    act(() => native.callbacks[0]({ payload: huge }));
    expect(prepareContext).toHaveBeenCalledTimes(2);
    const prompt = prepareContext.mock.calls[1][0];
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(
      MAX_VOICE_CONTINUITY_UTF8_BYTES,
    );
    expect(prompt).toContain("evidence-39");
    expect(prompt).toContain("新しい優先事項39");
    expect(prompt).toContain("continuity_context");
    expect(prompt).toContain("omitted");
    expect(JSON.stringify(huge)).toBe(original);
    act(() => native.callbacks[0]({ payload: { ...huge, revision: 3, phase: "thinking" } }));
    expect(prepareContext).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
    view.unmount();
  });

  it("does not feed new voice transcripts back into Live while still delivering work progress", async () => {
    const saved = snapshot("yori-ja", 1, "Earlier voice conversation");
    const initial: ContinuitySnapshot = {
      ...saved,
      messages: [{ ...saved.messages[0], source: "voice" }],
    };
    native.invoke.mockResolvedValue(initial);
    const prepareContext = vi.fn(async (_text: string) => {});
    const onError = vi.fn();
    const view = renderHook(() =>
      useContinuityVoiceContext({
        personaId: "yori-ja",
        active: true,
        prepareContext,
        onError,
      }),
    );
    await waitFor(() => expect(prepareContext).toHaveBeenCalledOnce());
    const observed = {
      ...initial,
      revision: 2,
      messages: [
        ...initial.messages,
        { ...initial.messages[0], id: "live-1", content: "Do the next step" },
      ],
    };
    act(() => native.callbacks[0]({ payload: observed }));
    act(() => native.callbacks[0]({ payload: { ...observed, revision: 3, phase: "thinking" } }));
    expect(prepareContext).toHaveBeenCalledTimes(1);

    const progressed = {
      ...observed,
      revision: 4,
      drafts: [
        {
          id: "draft-1",
          title: "Work result",
          content: "The actual completed draft",
          status: "ready" as const,
          reason: "Requested work",
          sourceIds: ["live-1"],
          createdAt: 4,
          updatedAt: 4,
        },
      ],
    };
    act(() => native.callbacks[0]({ payload: progressed }));
    expect(prepareContext).toHaveBeenCalledTimes(2);
    expect(prepareContext.mock.calls[1][0]).toContain("The actual completed draft");
    expect(prepareContext.mock.calls[1][0]).toContain("Earlier voice conversation");
    expect(prepareContext.mock.calls[1][0]).not.toContain("Do the next step");

    act(() =>
      native.callbacks[0]({
        payload: {
          ...progressed,
          revision: 5,
          messages: [
            ...progressed.messages,
            {
              ...initial.messages[0],
              id: "typed-1",
              content: "Written clarification",
              source: "conversation",
            },
          ],
        },
      }),
    );
    expect(prepareContext).toHaveBeenCalledTimes(3);
    expect(prepareContext.mock.calls[2][0]).toContain("Written clarification");
    act(() =>
      native.callbacks[0]({
        payload: {
          ...progressed,
          revision: 6,
          messages: [
            ...progressed.messages,
            {
              ...initial.messages[0],
              id: "main-1",
              role: "assistant",
              content: "Main Agent completed the requested investigation",
              source: "external",
            },
          ],
        },
      }),
    );
    expect(prepareContext).toHaveBeenCalledTimes(4);
    expect(prepareContext.mock.calls[3][0]).toContain("completed the requested investigation");
    view.unmount();
  });
});

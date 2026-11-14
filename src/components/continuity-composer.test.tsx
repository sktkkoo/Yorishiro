// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { type PropsWithChildren, StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sendContinuityMessage } from "../runtime/continuity/client";
import type { ContinuityContext } from "../runtime/continuity/types";
import { useContinuityComposer } from "./continuity-composer";
import { activeContinuityInput, editContinuityInput, selectCorrection } from "./continuity-input";

vi.mock("../runtime/continuity/client", () => ({ sendContinuityMessage: vi.fn() }));
let sequence = 0;
const persona = () => `composer-test-${++sequence}`;
const context = (personaId: string): ContinuityContext => ({
  personaId,
  personaName: "Test",
  personaPrompt: "",
  language: "en",
  cwd: "/original",
});
function pendingSend() {
  let resolve!: () => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  localStorage.clear();
  vi.mocked(sendContinuityMessage).mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  cleanup();
  await Promise.resolve();
  vi.restoreAllMocks();
});

it("keeps pending sends through persona changes and full remount while another persona sends independently", async () => {
  const a = persona();
  const b = persona();
  const first = pendingSend();
  const second = pendingSend();
  vi.mocked(sendContinuityMessage)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const hook = renderHook(({ id }) => useContinuityComposer(id), { initialProps: { id: a } });
  act(() => hook.result.current.updateInput((input) => editContinuityInput(input, "Message A")));
  act(() => {
    void hook.result.current.send(context(a));
    expect(hook.result.current.send(context(a))).toBeNull();
  });
  hook.rerender({ id: b });
  expect(hook.result.current.sending).toBe(false);
  expect(activeContinuityInput(hook.result.current.input).text).toBe("");
  act(() => hook.result.current.updateInput((input) => editContinuityInput(input, "Message B")));
  act(() => {
    void hook.result.current.send(context(b));
  });
  hook.unmount();
  const returned = renderHook(({ id }) => useContinuityComposer(id), { initialProps: { id: a } });
  expect(returned.result.current.sending).toBe(true);
  expect(activeContinuityInput(returned.result.current.input).text).toBe("Message A");
  act(() => expect(returned.result.current.send(context(a))).toBeNull());
  await act(async () => first.resolve());
  expect(returned.result.current.sending).toBe(false);
  expect(activeContinuityInput(returned.result.current.input).text).toBe("");
  returned.rerender({ id: b });
  expect(returned.result.current.sending).toBe(true);
  await act(async () => second.resolve());
  expect(activeContinuityInput(returned.result.current.input).text).toBe("");
  expect(sendContinuityMessage).toHaveBeenNthCalledWith(1, context(a), "Message A", undefined);
  expect(sendContinuityMessage).toHaveBeenNthCalledWith(2, context(b), "Message B", undefined);
});

it("persists a correction acknowledgement while detached and restores the normal unsent draft", async () => {
  const id = persona();
  const pending = pendingSend();
  vi.mocked(sendContinuityMessage).mockReturnValueOnce(pending.promise);
  const hook = renderHook(() => useContinuityComposer(id));
  act(() =>
    hook.result.current.updateInput((input) =>
      selectCorrection(editContinuityInput(input, "Normal draft"), "memory-a", "Correction A"),
    ),
  );
  act(() => {
    void hook.result.current.send(context(id));
  });
  hook.unmount();
  await act(async () => pending.resolve());
  const returned = renderHook(() => useContinuityComposer(id));
  expect(returned.result.current.input.target.id).toBeNull();
  expect(activeContinuityInput(returned.result.current.input).text).toBe("Normal draft");
  expect(returned.result.current.input.corrections.has("memory-a")).toBe(false);
  expect(returned.result.current.sending).toBe(false);
  expect(sendContinuityMessage).toHaveBeenCalledExactlyOnceWith(
    context(id),
    "Correction A",
    "memory-a",
  );
});

it.each([
  "edited",
  "reselected",
] as const)("preserves a %s correction through remount and detached acknowledgement", async (change) => {
  const id = persona();
  const pending = pendingSend();
  vi.mocked(sendContinuityMessage).mockReturnValueOnce(pending.promise);
  const hook = renderHook(() => useContinuityComposer(id));
  act(() =>
    hook.result.current.updateInput((input) => selectCorrection(input, "A", "Submitted A")),
  );
  act(() => {
    void hook.result.current.send(context(id));
  });
  hook.unmount();
  const returned = renderHook(() => useContinuityComposer(id));
  act(() =>
    returned.result.current.updateInput((input) =>
      change === "edited"
        ? editContinuityInput(input, "Newer A")
        : selectCorrection(selectCorrection(input, "B", "Draft B"), "A", "Submitted A"),
    ),
  );
  returned.unmount();
  await act(async () => pending.resolve());
  const completed = renderHook(() => useContinuityComposer(id));
  expect(completed.result.current.input.target.id).toBe("A");
  expect(activeContinuityInput(completed.result.current.input).text).toBe(
    change === "edited" ? "Newer A" : "Submitted A",
  );
  expect(completed.result.current.sending).toBe(false);
});

it("retains a detached failure until committed return, permits retry and evicts observed failure after detach", async () => {
  const id = persona();
  const pending = pendingSend();
  vi.mocked(sendContinuityMessage).mockReturnValueOnce(pending.promise);
  const hook = renderHook(() => useContinuityComposer(id));
  act(() =>
    hook.result.current.updateInput((input) => editContinuityInput(input, "Unsent message")),
  );
  let completion!: Promise<void> | null;
  act(() => {
    completion = hook.result.current.send(context(id));
  });
  const rejection = expect(completion).rejects.toThrow("Send failed away");
  hook.unmount();
  await act(async () => {
    pending.reject(new Error("Send failed away"));
    await rejection;
  });
  const returned = renderHook(() => useContinuityComposer(id));
  expect(returned.result.current.error).toBe("Send failed away");
  expect(returned.result.current.sending).toBe(false);
  expect(activeContinuityInput(returned.result.current.input).text).toBe("Unsent message");
  returned.unmount();
  await act(async () => {});
  const observed = renderHook(() => useContinuityComposer(id));
  expect(observed.result.current.error).toBeNull();
  await act(async () => {
    await observed.result.current.send(context(id));
  });
  expect(activeContinuityInput(observed.result.current.input).text).toBe("");
  expect(sendContinuityMessage).toHaveBeenCalledTimes(2);
});

it("shares built-in aliases through StrictMode resubscription without losing the pending owner", async () => {
  const pending = pendingSend();
  vi.mocked(sendContinuityMessage).mockReturnValueOnce(pending.promise);
  const wrapper = ({ children }: PropsWithChildren) => <StrictMode>{children}</StrictMode>;
  const hook = renderHook(({ id }) => useContinuityComposer(id), {
    initialProps: { id: "yori-ja" },
    wrapper,
  });
  act(() =>
    hook.result.current.updateInput((input) => editContinuityInput(input, "Same resident")),
  );
  act(() => {
    void hook.result.current.send(context("yori-ja"));
  });
  hook.rerender({ id: "yori-en" });
  expect(hook.result.current.sending).toBe(true);
  expect(hook.result.current.send(context("yori-en"))).toBeNull();
  await act(async () => pending.resolve());
  expect(activeContinuityInput(hook.result.current.input).text).toBe("");
  expect(sendContinuityMessage).toHaveBeenCalledTimes(1);
});

it("does not acknowledge an unseen failure during hidden persona visits", async () => {
  const a = persona();
  const b = persona();
  const pending = pendingSend();
  vi.mocked(sendContinuityMessage).mockReturnValueOnce(pending.promise);
  const hook = renderHook(({ id, visible }) => useContinuityComposer(id, visible), {
    initialProps: { id: a, visible: true },
  });
  act(() =>
    hook.result.current.updateInput((input) => editContinuityInput(input, "Unseen failure")),
  );
  let completion!: Promise<void> | null;
  act(() => {
    completion = hook.result.current.send(context(a));
  });
  const rejection = expect(completion).rejects.toThrow("Not yet shown");
  hook.rerender({ id: b, visible: false });
  await act(async () => {
    pending.reject(new Error("Not yet shown"));
    await rejection;
  });
  hook.rerender({ id: a, visible: false });
  expect(hook.result.current.error).toBe("Not yet shown");
  hook.rerender({ id: b, visible: false });
  await act(async () => {});
  hook.rerender({ id: a, visible: true });
  expect(hook.result.current.error).toBe("Not yet shown");
  hook.rerender({ id: b, visible: false });
  await act(async () => {});
  hook.rerender({ id: a, visible: true });
  expect(hook.result.current.error).toBeNull();
  expect(activeContinuityInput(hook.result.current.input).text).toBe("Unseen failure");
});

it("keeps actual edits and acknowledgements in memory when storage writes fail", async () => {
  const id = persona();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  const pending = pendingSend();
  vi.mocked(sendContinuityMessage).mockReturnValueOnce(pending.promise);
  const hook = renderHook(() => useContinuityComposer(id));
  act(() =>
    hook.result.current.updateInput((input) => editContinuityInput(input, "Actual message")),
  );
  act(() => {
    void hook.result.current.send(context(id));
  });
  hook.unmount();
  await act(async () => pending.resolve());
  const returned = renderHook(() => useContinuityComposer(id));
  expect(activeContinuityInput(returned.result.current.input).text).toBe("");
  expect(returned.result.current.sending).toBe(false);
  expect(sendContinuityMessage).toHaveBeenCalledTimes(1);
});

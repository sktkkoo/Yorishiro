// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { AttentionRuntime } from "../attention-runtime/types";
import { startToolAttentionProducer } from "./tool";

function makeFakeAttention() {
  const setSourceTarget = vi.fn();
  const get = vi.fn(() => ({ target: null }));
  const subscribe = vi.fn(() => ({ dispose: () => {} }));
  const fake = { setSourceTarget, get, subscribe };
  return fake as unknown as AttentionRuntime & typeof fake;
}

type SubscribeHookSignal = Parameters<typeof startToolAttentionProducer>[0]["subscribeHookSignal"];

function makeFakeHookSignal() {
  let handler: ((event: { name: string }) => void) | null = null;
  const subscribeHookSignalFn = vi.fn((h: (event: { name: string }) => void) => {
    handler = h;
    return { dispose: vi.fn() };
  });
  const subscribeHookSignal = subscribeHookSignalFn as unknown as SubscribeHookSignal &
    typeof subscribeHookSignalFn;
  return {
    subscribeHookSignal,
    emit(event: { name: string }) {
      if (handler) handler(event);
    },
  };
}

describe("startToolAttentionProducer", () => {
  it("emits tool-running on pre-tool-use signal with rect from getter", () => {
    const attention = makeFakeAttention();
    const hookSignal = makeFakeHookSignal();
    const getCurrentLineRect = vi.fn(() => ({ x: 5, y: 50, width: 200, height: 16 }));

    const dispose = startToolAttentionProducer({
      attention,
      subscribeHookSignal: hookSignal.subscribeHookSignal,
      getCurrentLineRect,
    });

    hookSignal.emit({ name: "pre-tool-use" });

    const call = attention.setSourceTarget.mock.calls.find((c) => c[0] === "tool-running");
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({
      kind: "terminal-region",
      source: "tool-running",
      priority: 6,
      reason: "tool-running",
    });
    dispose.dispose();
  });

  it("emits tool-diagnostic on post-tool-failure signal", () => {
    const attention = makeFakeAttention();
    const hookSignal = makeFakeHookSignal();
    const getCurrentLineRect = vi.fn(() => ({ x: 5, y: 70, width: 200, height: 16 }));

    const dispose = startToolAttentionProducer({
      attention,
      subscribeHookSignal: hookSignal.subscribeHookSignal,
      getCurrentLineRect,
    });

    hookSignal.emit({ name: "post-tool-failure" });

    const call = attention.setSourceTarget.mock.calls.find((c) => c[0] === "tool-diagnostic");
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({
      source: "tool-diagnostic",
      priority: 8,
      reason: "diagnostic",
    });
    dispose.dispose();
  });

  it("clears tool-running and tool-diagnostic on stop signal when previously active", () => {
    const attention = makeFakeAttention();
    const hookSignal = makeFakeHookSignal();
    const getCurrentLineRect = vi.fn(() => ({ x: 5, y: 70, width: 200, height: 16 }));

    const dispose = startToolAttentionProducer({
      attention,
      subscribeHookSignal: hookSignal.subscribeHookSignal,
      getCurrentLineRect,
    });

    // 先に両 source を active にする
    hookSignal.emit({ name: "pre-tool-use" });
    hookSignal.emit({ name: "post-tool-failure" });

    // それから stop で両 clear
    hookSignal.emit({ name: "stop" });

    const runningClear = attention.setSourceTarget.mock.calls.find(
      (c) => c[0] === "tool-running" && c[1] === null,
    );
    const diagnosticClear = attention.setSourceTarget.mock.calls.find(
      (c) => c[0] === "tool-diagnostic" && c[1] === null,
    );
    expect(runningClear).toBeDefined();
    expect(diagnosticClear).toBeDefined();
    dispose.dispose();
  });

  it("does not clear on stop signal when never previously active (stateful)", () => {
    const attention = makeFakeAttention();
    const hookSignal = makeFakeHookSignal();
    const getCurrentLineRect = vi.fn(() => null);

    const dispose = startToolAttentionProducer({
      attention,
      subscribeHookSignal: hookSignal.subscribeHookSignal,
      getCurrentLineRect,
    });

    hookSignal.emit({ name: "stop" });

    // virgin state: stop で setSourceTarget(null) は呼ばれない
    expect(attention.setSourceTarget).not.toHaveBeenCalled();
    dispose.dispose();
  });

  it("dispose unsubscribes from hook signal", () => {
    const attention = makeFakeAttention();
    const handlerDispose = vi.fn();
    const subscribeHookSignalFn = vi.fn(() => ({ dispose: handlerDispose }));
    const subscribeHookSignal = subscribeHookSignalFn as unknown as SubscribeHookSignal &
      typeof subscribeHookSignalFn;
    const handle = startToolAttentionProducer({
      attention,
      subscribeHookSignal,
      getCurrentLineRect: () => null,
    });

    handle.dispose();
    expect(handlerDispose).toHaveBeenCalled();
  });
});

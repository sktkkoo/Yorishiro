// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { AttentionRuntime } from "../attention-runtime/types";
import { startToolAttentionProducer } from "./tool";

interface FakeAttention {
  readonly setSourceTarget: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
  readonly subscribe: ReturnType<typeof vi.fn>;
}

function makeFakeAttention(): FakeAttention {
  return {
    setSourceTarget: vi.fn(),
    get: vi.fn(() => ({ target: null })),
    subscribe: vi.fn(() => ({ dispose: () => {} })),
  };
}

interface FakeHookSignal {
  readonly subscribeHookSignal: ReturnType<typeof vi.fn>;
  emit(event: { name: string }): void;
}

function makeFakeHookSignal(): FakeHookSignal {
  let handler: ((event: { name: string }) => void) | null = null;
  return {
    subscribeHookSignal: vi.fn((h: (event: { name: string }) => void) => {
      handler = h;
      return { dispose: vi.fn() };
    }),
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
      attention: attention as unknown as AttentionRuntime,
      subscribeHookSignal: hookSignal.subscribeHookSignal as unknown as Parameters<
        typeof startToolAttentionProducer
      >[0]["subscribeHookSignal"],
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
      attention: attention as unknown as AttentionRuntime,
      subscribeHookSignal: hookSignal.subscribeHookSignal as unknown as Parameters<
        typeof startToolAttentionProducer
      >[0]["subscribeHookSignal"],
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

  it("clears tool-running and tool-diagnostic on stop signal", () => {
    const attention = makeFakeAttention();
    const hookSignal = makeFakeHookSignal();
    const getCurrentLineRect = vi.fn(() => null);

    const dispose = startToolAttentionProducer({
      attention: attention as unknown as AttentionRuntime,
      subscribeHookSignal: hookSignal.subscribeHookSignal as unknown as Parameters<
        typeof startToolAttentionProducer
      >[0]["subscribeHookSignal"],
      getCurrentLineRect,
    });

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

  it("dispose unsubscribes from hook signal", () => {
    const attention = makeFakeAttention();
    const handlerDispose = vi.fn();
    const subscribeHookSignal = vi.fn(() => ({ dispose: handlerDispose }));
    const handle = startToolAttentionProducer({
      attention: attention as unknown as AttentionRuntime,
      subscribeHookSignal: subscribeHookSignal as unknown as Parameters<
        typeof startToolAttentionProducer
      >[0]["subscribeHookSignal"],
      getCurrentLineRect: () => null,
    });

    handle.dispose();
    expect(handlerDispose).toHaveBeenCalled();
  });
});

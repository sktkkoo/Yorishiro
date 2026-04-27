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
type SubscribeToolActivity = Parameters<
  typeof startToolAttentionProducer
>[0]["subscribeToolActivity"];

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

function makeFakeToolActivity() {
  let handler: ((event: { activity: string; timestamp: number }) => void) | null = null;
  const subscribeToolActivityFn = vi.fn(
    (h: (event: { activity: string; timestamp: number }) => void) => {
      handler = h;
      return { dispose: vi.fn() };
    },
  );
  const subscribeToolActivity = subscribeToolActivityFn as unknown as SubscribeToolActivity &
    typeof subscribeToolActivityFn;
  return {
    subscribeToolActivity,
    emit(event: { activity: string; timestamp: number }) {
      if (handler) handler(event);
    },
  };
}

describe("startToolAttentionProducer", () => {
  it("tool-activity reading → tool-activity source を priority 4 で emit する", () => {
    const attention = makeFakeAttention();
    const hookSignal = makeFakeHookSignal();
    const toolActivity = makeFakeToolActivity();
    const getCurrentLineRect = vi.fn(() => ({ x: 5, y: 50, width: 200, height: 16 }));

    const dispose = startToolAttentionProducer({
      attention,
      subscribeHookSignal: hookSignal.subscribeHookSignal,
      subscribeToolActivity: toolActivity.subscribeToolActivity,
      getCurrentLineRect,
    });

    toolActivity.emit({ activity: "reading", timestamp: 1000 });

    const call = attention.setSourceTarget.mock.calls.find((c) => c[0] === "tool-activity");
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({
      kind: "terminal-region",
      source: "tool-activity",
      priority: 4,
      confidence: 0.72,
      reason: "tool-reading",
    });
    dispose.dispose();
  });

  it("tool-activity writing → reason: tool-writing", () => {
    const attention = makeFakeAttention();
    const hookSignal = makeFakeHookSignal();
    const toolActivity = makeFakeToolActivity();
    const getCurrentLineRect = vi.fn(() => ({ x: 5, y: 50, width: 200, height: 16 }));

    const dispose = startToolAttentionProducer({
      attention,
      subscribeHookSignal: hookSignal.subscribeHookSignal,
      subscribeToolActivity: toolActivity.subscribeToolActivity,
      getCurrentLineRect,
    });

    toolActivity.emit({ activity: "writing", timestamp: 2000 });

    const call = attention.setSourceTarget.mock.calls.find((c) => c[0] === "tool-activity");
    expect(call?.[1]).toMatchObject({ reason: "tool-writing" });
    dispose.dispose();
  });

  it("tool-activity running → reason: tool-running", () => {
    const attention = makeFakeAttention();
    const hookSignal = makeFakeHookSignal();
    const toolActivity = makeFakeToolActivity();
    const getCurrentLineRect = vi.fn(() => ({ x: 5, y: 50, width: 200, height: 16 }));

    const dispose = startToolAttentionProducer({
      attention,
      subscribeHookSignal: hookSignal.subscribeHookSignal,
      subscribeToolActivity: toolActivity.subscribeToolActivity,
      getCurrentLineRect,
    });

    toolActivity.emit({ activity: "running", timestamp: 3000 });

    const call = attention.setSourceTarget.mock.calls.find((c) => c[0] === "tool-activity");
    expect(call?.[1]).toMatchObject({ reason: "tool-running" });
    dispose.dispose();
  });

  it("tool-activity none → tool-activity source を clear する（active 状態から）", () => {
    const attention = makeFakeAttention();
    const hookSignal = makeFakeHookSignal();
    const toolActivity = makeFakeToolActivity();
    const getCurrentLineRect = vi.fn(() => ({ x: 5, y: 50, width: 200, height: 16 }));

    const dispose = startToolAttentionProducer({
      attention,
      subscribeHookSignal: hookSignal.subscribeHookSignal,
      subscribeToolActivity: toolActivity.subscribeToolActivity,
      getCurrentLineRect,
    });

    // 先に active にしてから none で clear
    toolActivity.emit({ activity: "reading", timestamp: 1000 });
    toolActivity.emit({ activity: "none", timestamp: 2000 });

    const clearCall = attention.setSourceTarget.mock.calls.find(
      (c) => c[0] === "tool-activity" && c[1] === null,
    );
    expect(clearCall).toBeDefined();
    dispose.dispose();
  });

  it("post-tool-failure → tool-diagnostic source を priority 6 で emit する", () => {
    const attention = makeFakeAttention();
    const hookSignal = makeFakeHookSignal();
    const toolActivity = makeFakeToolActivity();
    const getCurrentLineRect = vi.fn(() => ({ x: 5, y: 70, width: 200, height: 16 }));

    const dispose = startToolAttentionProducer({
      attention,
      subscribeHookSignal: hookSignal.subscribeHookSignal,
      subscribeToolActivity: toolActivity.subscribeToolActivity,
      getCurrentLineRect,
    });

    hookSignal.emit({ name: "post-tool-failure" });

    const call = attention.setSourceTarget.mock.calls.find((c) => c[0] === "tool-diagnostic");
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({
      kind: "terminal-region",
      source: "tool-diagnostic",
      priority: 6,
      confidence: 0.8,
      reason: "diagnostic",
    });
    dispose.dispose();
  });

  it("stop → tool-activity が active なら clear する", () => {
    const attention = makeFakeAttention();
    const hookSignal = makeFakeHookSignal();
    const toolActivity = makeFakeToolActivity();
    const getCurrentLineRect = vi.fn(() => ({ x: 5, y: 70, width: 200, height: 16 }));

    const dispose = startToolAttentionProducer({
      attention,
      subscribeHookSignal: hookSignal.subscribeHookSignal,
      subscribeToolActivity: toolActivity.subscribeToolActivity,
      getCurrentLineRect,
    });

    toolActivity.emit({ activity: "reading", timestamp: 1000 });
    hookSignal.emit({ name: "stop" });

    const clearCall = attention.setSourceTarget.mock.calls.find(
      (c) => c[0] === "tool-activity" && c[1] === null,
    );
    expect(clearCall).toBeDefined();
    dispose.dispose();
  });

  it("stop → tool-activity が inactive なら setSourceTarget を呼ばない（stateful）", () => {
    const attention = makeFakeAttention();
    const hookSignal = makeFakeHookSignal();
    const toolActivity = makeFakeToolActivity();
    const getCurrentLineRect = vi.fn(() => null);

    const dispose = startToolAttentionProducer({
      attention,
      subscribeHookSignal: hookSignal.subscribeHookSignal,
      subscribeToolActivity: toolActivity.subscribeToolActivity,
      getCurrentLineRect,
    });

    hookSignal.emit({ name: "stop" });

    // virgin state: stop で setSourceTarget は呼ばれない
    expect(attention.setSourceTarget).not.toHaveBeenCalled();
    dispose.dispose();
  });

  it("dispose で両 subscription が unsubscribe される", () => {
    const attention = makeFakeAttention();
    const hookDisposeInner = vi.fn();
    const activityDisposeInner = vi.fn();
    const subscribeHookSignal = vi.fn(() => ({
      dispose: hookDisposeInner,
    })) as unknown as SubscribeHookSignal;
    const subscribeToolActivity = vi.fn(() => ({
      dispose: activityDisposeInner,
    })) as unknown as SubscribeToolActivity;

    const handle = startToolAttentionProducer({
      attention,
      subscribeHookSignal,
      subscribeToolActivity,
      getCurrentLineRect: () => null,
    });

    handle.dispose();
    expect(hookDisposeInner).toHaveBeenCalled();
    expect(activityDisposeInner).toHaveBeenCalled();
  });

  it("getCurrentLineRect が null → tool-activity を emit しない", () => {
    const attention = makeFakeAttention();
    const hookSignal = makeFakeHookSignal();
    const toolActivity = makeFakeToolActivity();
    const getCurrentLineRect = vi.fn(() => null);

    const dispose = startToolAttentionProducer({
      attention,
      subscribeHookSignal: hookSignal.subscribeHookSignal,
      subscribeToolActivity: toolActivity.subscribeToolActivity,
      getCurrentLineRect,
    });

    toolActivity.emit({ activity: "reading", timestamp: 1000 });

    expect(attention.setSourceTarget).not.toHaveBeenCalled();
    dispose.dispose();
  });

  it("getCurrentLineRect が null → tool-diagnostic を emit しない", () => {
    const attention = makeFakeAttention();
    const hookSignal = makeFakeHookSignal();
    const toolActivity = makeFakeToolActivity();
    const getCurrentLineRect = vi.fn(() => null);

    const dispose = startToolAttentionProducer({
      attention,
      subscribeHookSignal: hookSignal.subscribeHookSignal,
      subscribeToolActivity: toolActivity.subscribeToolActivity,
      getCurrentLineRect,
    });

    hookSignal.emit({ name: "post-tool-failure" });

    expect(attention.setSourceTarget).not.toHaveBeenCalled();
    dispose.dispose();
  });

  it("tool-activity は 3 秒で auto null clear (pulse)", () => {
    vi.useFakeTimers();
    try {
      const attention = makeFakeAttention();
      const hookSignal = makeFakeHookSignal();
      const toolActivity = makeFakeToolActivity();
      const getCurrentLineRect = vi.fn(() => ({ x: 0, y: 0, width: 100, height: 20 }));

      const dispose = startToolAttentionProducer({
        attention,
        subscribeHookSignal: hookSignal.subscribeHookSignal,
        subscribeToolActivity: toolActivity.subscribeToolActivity,
        getCurrentLineRect,
      });

      toolActivity.emit({ activity: "running", timestamp: 1000 });
      const emitCall = attention.setSourceTarget.mock.calls.find(
        (c) => c[0] === "tool-activity" && c[1] !== null,
      );
      expect(emitCall).toBeDefined();

      vi.advanceTimersByTime(3100);
      const clearCall = attention.setSourceTarget.mock.calls.find(
        (c) => c[0] === "tool-activity" && c[1] === null,
      );
      expect(clearCall).toBeDefined();
      dispose.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("連続 activity で pulse timer が上書きされる (前 timer は cancel)", () => {
    vi.useFakeTimers();
    try {
      const attention = makeFakeAttention();
      const hookSignal = makeFakeHookSignal();
      const toolActivity = makeFakeToolActivity();
      const getCurrentLineRect = vi.fn(() => ({ x: 0, y: 0, width: 100, height: 20 }));

      const dispose = startToolAttentionProducer({
        attention,
        subscribeHookSignal: hookSignal.subscribeHookSignal,
        subscribeToolActivity: toolActivity.subscribeToolActivity,
        getCurrentLineRect,
      });

      toolActivity.emit({ activity: "reading", timestamp: 1000 });
      vi.advanceTimersByTime(2000);
      toolActivity.emit({ activity: "writing", timestamp: 3000 });
      vi.advanceTimersByTime(2000); // 元 timer なら clear、上書きなら未だ active
      const clearBeforeNewTimer = attention.setSourceTarget.mock.calls.filter(
        (c) => c[0] === "tool-activity" && c[1] === null,
      );
      expect(clearBeforeNewTimer.length).toBe(0);

      vi.advanceTimersByTime(1500); // 新 timer 完了
      const clearAfterNewTimer = attention.setSourceTarget.mock.calls.filter(
        (c) => c[0] === "tool-activity" && c[1] === null,
      );
      expect(clearAfterNewTimer.length).toBe(1);
      dispose.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

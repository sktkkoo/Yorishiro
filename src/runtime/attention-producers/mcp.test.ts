// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { AttentionRuntime } from "../attention-runtime/types";
import type { ListenFactory } from "./mcp";
import { startMcpAttentionProducer } from "./mcp";

function makeFakeAttention() {
  const setSourceTarget = vi.fn();
  const get = vi.fn(() => ({ target: null }));
  const subscribe = vi.fn(() => ({ dispose: () => {} }));
  const fake = { setSourceTarget, get, subscribe };
  return fake as unknown as AttentionRuntime & typeof fake;
}

/** listen factory の fake。handler を外部から呼び出せるよう ref で保持する。 */
function makeFakeListen() {
  let capturedHandler: ((payload: { tool: string }) => void) | null = null;
  const disposeInner = vi.fn();

  const listenFn = (_name: string, h: (payload: { tool: string }) => void) => {
    capturedHandler = h;
    return { dispose: disposeInner };
  };
  const listen = listenFn as unknown as ListenFactory & typeof listenFn;

  return {
    listen,
    disposeInner,
    emit(payload: { tool: string }) {
      if (capturedHandler !== null) capturedHandler(payload);
    },
  };
}

function makeFakeTimers() {
  let scheduled: (() => void) | null = null;
  let timerId = 1;
  const setTimeoutFn = vi.fn((cb: () => void, _ms: number): number => {
    scheduled = cb;
    return timerId++;
  });
  const clearTimeoutFn = vi.fn((_id: number) => {
    scheduled = null;
  });
  const flush = () => {
    scheduled?.();
    scheduled = null;
  };
  return { setTimeoutFn, clearTimeoutFn, flush };
}

describe("startMcpAttentionProducer", () => {
  it("tool-request event で mcp-tool-request target を priority 4 で emit する", () => {
    const attention = makeFakeAttention();
    const { listen, emit } = makeFakeListen();
    const { setTimeoutFn, clearTimeoutFn } = makeFakeTimers();
    const getTargetRect = vi.fn(() => ({ x: 100, y: 50, width: 200, height: 400 }));

    const dispose = startMcpAttentionProducer({
      attention,
      listen,
      getTargetRect,
      setTimeout: setTimeoutFn,
      clearTimeout: clearTimeoutFn,
    });

    emit({ tool: "set-ui-state" });

    const call = attention.setSourceTarget.mock.calls.find((c) => c[0] === "mcp-tool-request");
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({
      kind: "mcp-ui",
      source: "mcp-tool-request",
      priority: 4,
      confidence: 0.72,
    });
    expect(call?.[1].rect.width).toBeGreaterThan(0);
    dispose.dispose();
  });

  it("set-ui-state → tool-writing、それ以外 → tool-reading", () => {
    const attention = makeFakeAttention();
    const { listen, emit } = makeFakeListen();
    const { setTimeoutFn, clearTimeoutFn } = makeFakeTimers();
    const getTargetRect = vi.fn(() => ({ x: 100, y: 50, width: 200, height: 400 }));

    const dispose = startMcpAttentionProducer({
      attention,
      listen,
      getTargetRect,
      setTimeout: setTimeoutFn,
      clearTimeout: clearTimeoutFn,
    });

    emit({ tool: "set-ui-state" });
    const calls1 = attention.setSourceTarget.mock.calls;
    const writingCall = calls1[calls1.length - 1];
    expect(writingCall?.[1].reason).toBe("tool-writing");

    emit({ tool: "get-ui-state" });
    const calls2 = attention.setSourceTarget.mock.calls;
    const readingCall = calls2[calls2.length - 1];
    expect(readingCall?.[1].reason).toBe("tool-reading");

    dispose.dispose();
  });

  it("1200ms 後に source を null clear する（setTimeout 経由）", () => {
    const attention = makeFakeAttention();
    const { listen, emit } = makeFakeListen();
    const { setTimeoutFn, clearTimeoutFn, flush } = makeFakeTimers();
    const getTargetRect = vi.fn(() => ({ x: 100, y: 50, width: 200, height: 400 }));

    const dispose = startMcpAttentionProducer({
      attention,
      listen,
      getTargetRect,
      setTimeout: setTimeoutFn,
      clearTimeout: clearTimeoutFn,
    });

    emit({ tool: "get-ui-state" });

    expect(setTimeoutFn).toHaveBeenCalledWith(expect.any(Function), 1200);

    // timer flush で null clear が来る
    flush();
    const clearCall = attention.setSourceTarget.mock.calls.find(
      (c) => c[0] === "mcp-tool-request" && c[1] === null,
    );
    expect(clearCall).toBeDefined();
    dispose.dispose();
  });

  it("getTargetRect が null を返したら emit しない", () => {
    const attention = makeFakeAttention();
    const { listen, emit } = makeFakeListen();
    const { setTimeoutFn, clearTimeoutFn } = makeFakeTimers();
    const getTargetRect = vi.fn(() => null);

    const dispose = startMcpAttentionProducer({
      attention,
      listen,
      getTargetRect,
      setTimeout: setTimeoutFn,
      clearTimeout: clearTimeoutFn,
    });

    emit({ tool: "get-ui-state" });

    expect(attention.setSourceTarget).not.toHaveBeenCalled();
    dispose.dispose();
  });

  it("dispose で event listener を解除し、pending timer を cancel する", () => {
    const attention = makeFakeAttention();
    const { listen, emit, disposeInner } = makeFakeListen();
    const { setTimeoutFn, clearTimeoutFn } = makeFakeTimers();
    const getTargetRect = vi.fn(() => ({ x: 100, y: 50, width: 200, height: 400 }));

    const handle = startMcpAttentionProducer({
      attention,
      listen,
      getTargetRect,
      setTimeout: setTimeoutFn,
      clearTimeout: clearTimeoutFn,
    });

    emit({ tool: "get-ui-state" });
    handle.dispose();

    expect(disposeInner).toHaveBeenCalled();
    expect(clearTimeoutFn).toHaveBeenCalled();
  });

  it("連続 event では前の timer を cancel して新しい timer をセットする", () => {
    const attention = makeFakeAttention();
    const { listen, emit } = makeFakeListen();
    const { setTimeoutFn, clearTimeoutFn } = makeFakeTimers();
    const getTargetRect = vi.fn(() => ({ x: 100, y: 50, width: 200, height: 400 }));

    const dispose = startMcpAttentionProducer({
      attention,
      listen,
      getTargetRect,
      setTimeout: setTimeoutFn,
      clearTimeout: clearTimeoutFn,
    });

    emit({ tool: "get-ui-state" });
    // 2 回目 emit 前に clearTimeout が呼ばれ、新 timer が設定される
    emit({ tool: "set-ui-state" });

    expect(clearTimeoutFn).toHaveBeenCalled();
    expect(setTimeoutFn).toHaveBeenCalledTimes(2);
    dispose.dispose();
  });
});

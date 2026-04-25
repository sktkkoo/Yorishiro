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

describe("startMcpAttentionProducer", () => {
  it("emits mcp-tool-request target on tool-request event", () => {
    const attention = makeFakeAttention();
    const { listen, emit } = makeFakeListen();
    const dispose = startMcpAttentionProducer({
      attention,
      listen,
    });

    emit({ tool: "set-ui-state" });

    const call = attention.setSourceTarget.mock.calls.find((c) => c[0] === "mcp-tool-request");
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({
      kind: "mcp-ui",
      source: "mcp-tool-request",
      priority: 6,
    });
    expect(call?.[1].rect.width).toBeGreaterThan(0);
    dispose.dispose();
  });

  it("uses tool-writing reason for set-ui-state, tool-reading for others", () => {
    const attention = makeFakeAttention();
    const { listen, emit } = makeFakeListen();
    const dispose = startMcpAttentionProducer({
      attention,
      listen,
    });

    emit({ tool: "set-ui-state" });
    const calls = attention.setSourceTarget.mock.calls;
    const writingCall = calls[calls.length - 1];
    expect(writingCall?.[1].reason).toBe("tool-writing");

    emit({ tool: "get-ui-state" });
    const calls2 = attention.setSourceTarget.mock.calls;
    const readingCall = calls2[calls2.length - 1];
    expect(readingCall?.[1].reason).toBe("tool-reading");

    dispose.dispose();
  });

  it("dispose unsubscribes from event listener", () => {
    const attention = makeFakeAttention();
    const { listen, disposeInner } = makeFakeListen();
    const handle = startMcpAttentionProducer({
      attention,
      listen,
    });

    handle.dispose();
    expect(disposeInner).toHaveBeenCalled();
  });
});

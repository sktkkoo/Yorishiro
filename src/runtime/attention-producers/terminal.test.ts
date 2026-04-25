import { describe, expect, it, vi } from "vitest";
import type { AttentionRuntime } from "../attention-runtime/types";
import type { TerminalRuntime } from "../terminal-runtime/types";
import { startTerminalAttentionProducer } from "./terminal";

function makeFakeAttention() {
  const setSourceTarget = vi.fn();
  const get = vi.fn(() => ({ target: null }));
  const subscribe = vi.fn(() => ({ dispose: () => {} }));
  const fake = { setSourceTarget, get, subscribe };
  return fake as unknown as AttentionRuntime & typeof fake;
}

function makeFakeTerminal(
  lines: Array<{ text: string; rect: { x: number; y: number; width: number; height: number } }>,
) {
  let ptyListener: (() => void) | null = null;
  const subscribePtyData = vi.fn((listener: () => void) => {
    ptyListener = listener;
    return {
      dispose: () => {
        ptyListener = null;
      },
    };
  });
  const subscribeViewportScroll = vi.fn(() => ({ dispose: () => {} }));
  const getViewportLineRects = vi.fn(() => lines);
  const fake = {
    subscribePtyData,
    subscribeViewportScroll,
    getViewportLineRects,
    emitPtyData() {
      if (ptyListener) ptyListener();
    },
  };
  return fake as unknown as TerminalRuntime & typeof fake;
}

describe("startTerminalAttentionProducer", () => {
  it("emits terminal:diagnostic target when an error line is observed", () => {
    const attention = makeFakeAttention();
    const terminal = makeFakeTerminal([
      { text: "Error: build failed", rect: { x: 10, y: 100, width: 200, height: 16 } },
    ]);
    const dispose = startTerminalAttentionProducer({
      attention,
      terminal,
    });

    terminal.emitPtyData();

    const calls = attention.setSourceTarget.mock.calls;
    const diagnosticCall = calls.find((c) => c[0] === "terminal:diagnostic");
    expect(diagnosticCall).toBeDefined();
    expect(diagnosticCall?.[1]).toMatchObject({
      kind: "terminal-region",
      source: "terminal:diagnostic",
      priority: 8,
      reason: "diagnostic",
    });
    dispose.dispose();
  });

  it("emits terminal:file-link target for path-like lines", () => {
    const attention = makeFakeAttention();
    const terminal = makeFakeTerminal([
      { text: "src/App.tsx:12", rect: { x: 10, y: 80, width: 200, height: 16 } },
    ]);
    const dispose = startTerminalAttentionProducer({
      attention,
      terminal,
    });

    terminal.emitPtyData();

    const fileLinkCall = attention.setSourceTarget.mock.calls.find(
      (c) => c[0] === "terminal:file-link",
    );
    expect(fileLinkCall).toBeDefined();
    expect(fileLinkCall?.[1]).toMatchObject({
      kind: "terminal-region",
      source: "terminal:file-link",
      priority: 5,
      reason: "file-link",
    });
    dispose.dispose();
  });

  it("does not emit anything for plain recent-output lines (no semantic marker)", () => {
    const attention = makeFakeAttention();
    const terminal = makeFakeTerminal([
      { text: "Listening on port 1430", rect: { x: 10, y: 60, width: 200, height: 16 } },
    ]);
    const dispose = startTerminalAttentionProducer({
      attention,
      terminal,
    });

    terminal.emitPtyData();

    expect(attention.setSourceTarget).not.toHaveBeenCalled();
    dispose.dispose();
  });

  it("emits both terminal:diagnostic and terminal:file-link in parallel when viewport contains both", () => {
    const attention = makeFakeAttention();
    const terminal = makeFakeTerminal([
      { text: "src/App.tsx:12", rect: { x: 10, y: 50, width: 200, height: 16 } },
      { text: "Error: build failed", rect: { x: 10, y: 100, width: 200, height: 16 } },
    ]);
    const dispose = startTerminalAttentionProducer({
      attention,
      terminal,
    });

    terminal.emitPtyData();

    const diagnosticCall = attention.setSourceTarget.mock.calls.find(
      (c) => c[0] === "terminal:diagnostic" && c[1] !== null,
    );
    const fileLinkCall = attention.setSourceTarget.mock.calls.find(
      (c) => c[0] === "terminal:file-link" && c[1] !== null,
    );
    expect(diagnosticCall).toBeDefined();
    expect(fileLinkCall).toBeDefined();
    dispose.dispose();
  });

  it("clears terminal:diagnostic with null when a previous diagnostic line is no longer present", () => {
    const attention = makeFakeAttention();
    const lines: Array<{
      text: string;
      rect: { x: number; y: number; width: number; height: number };
    }> = [{ text: "Error: build failed", rect: { x: 10, y: 100, width: 200, height: 16 } }];
    const terminal = makeFakeTerminal(lines);
    const dispose = startTerminalAttentionProducer({
      attention,
      terminal,
    });

    terminal.emitPtyData();
    // first scan: diagnostic emitted

    // viewport が変わって diagnostic が消えた状態を simulate
    lines.length = 0;
    lines.push({ text: "OK", rect: { x: 10, y: 100, width: 200, height: 16 } });
    terminal.emitPtyData();

    // second scan: 前回 active だった diagnostic を null で clear
    const nullCall = attention.setSourceTarget.mock.calls.find(
      (c) => c[0] === "terminal:diagnostic" && c[1] === null,
    );
    expect(nullCall).toBeDefined();
    dispose.dispose();
  });

  it("dispose unsubscribes from pty and scroll listeners", () => {
    const attention = makeFakeAttention();
    const ptyDispose = vi.fn();
    const scrollDispose = vi.fn();
    const terminal = {
      subscribePtyData: vi.fn(() => ({ dispose: ptyDispose })),
      subscribeViewportScroll: vi.fn(() => ({ dispose: scrollDispose })),
      getViewportLineRects: vi.fn(() => []),
    };
    const handle = startTerminalAttentionProducer({
      attention,
      terminal,
    });

    handle.dispose();

    expect(ptyDispose).toHaveBeenCalled();
    expect(scrollDispose).toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import type { AttentionRuntime } from "../attention-runtime/types";
import type { TerminalRuntime } from "../terminal-runtime/types";
import { startTerminalAttentionProducer } from "./terminal";

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

interface FakeTerminal {
  readonly subscribePtyData: ReturnType<typeof vi.fn>;
  readonly subscribeViewportScroll: ReturnType<typeof vi.fn>;
  readonly getViewportLineRects: ReturnType<typeof vi.fn>;
  emitPtyData(): void;
}

function makeFakeTerminal(
  lines: Array<{ text: string; rect: { x: number; y: number; width: number; height: number } }>,
): FakeTerminal &
  Pick<TerminalRuntime, "subscribePtyData" | "subscribeViewportScroll" | "getViewportLineRects"> {
  let ptyListener: (() => void) | null = null;
  return {
    subscribePtyData: vi.fn((listener: () => void) => {
      ptyListener = listener;
      return {
        dispose: () => {
          ptyListener = null;
        },
      };
    }),
    subscribeViewportScroll: vi.fn(() => ({ dispose: () => {} })),
    getViewportLineRects: vi.fn(() => lines),
    emitPtyData() {
      if (ptyListener) ptyListener();
    },
  };
}

describe("startTerminalAttentionProducer", () => {
  it("emits terminal:diagnostic target when an error line is observed", () => {
    const attention = makeFakeAttention();
    const terminal = makeFakeTerminal([
      { text: "Error: build failed", rect: { x: 10, y: 100, width: 200, height: 16 } },
    ]);
    const dispose = startTerminalAttentionProducer({
      attention: attention as unknown as AttentionRuntime,
      terminal: terminal as unknown as TerminalRuntime,
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
      attention: attention as unknown as AttentionRuntime,
      terminal: terminal as unknown as TerminalRuntime,
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
      attention: attention as unknown as AttentionRuntime,
      terminal: terminal as unknown as TerminalRuntime,
    });

    terminal.emitPtyData();

    // recent-output line のみの場合、何も新規 emit しない
    // ただし diagnostic / file-link 不在で source を null にする呼び出しはあり得る
    const diagnosticEmissions = attention.setSourceTarget.mock.calls.filter(
      (c) => c[0] === "terminal:diagnostic" && c[1] !== null,
    );
    const fileLinkEmissions = attention.setSourceTarget.mock.calls.filter(
      (c) => c[0] === "terminal:file-link" && c[1] !== null,
    );
    expect(diagnosticEmissions).toHaveLength(0);
    expect(fileLinkEmissions).toHaveLength(0);
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
      attention: attention as unknown as AttentionRuntime,
      terminal: terminal as unknown as TerminalRuntime,
    });

    handle.dispose();

    expect(ptyDispose).toHaveBeenCalled();
    expect(scrollDispose).toHaveBeenCalled();
  });
});

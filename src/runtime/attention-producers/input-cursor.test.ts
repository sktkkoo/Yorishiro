// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { AttentionRuntime } from "../attention-runtime/types";
import type { TerminalRuntime } from "../terminal-runtime/types";
import { startInputCursorAttentionProducer } from "./input-cursor";

function makeFakeAttention() {
  const setSourceTarget = vi.fn();
  const get = vi.fn(() => ({ target: null }));
  const subscribe = vi.fn(() => ({ dispose: () => {} }));
  const fake = { setSourceTarget, get, subscribe };
  return fake as unknown as AttentionRuntime & typeof fake;
}

function makeFakeTerminal(
  cursor: ReturnType<TerminalRuntime["getInputCursorClientPosition"]> | null,
) {
  let listener: (() => void) | null = null;
  const subscribePtyData = vi.fn((l: () => void) => {
    listener = l;
    return {
      dispose: () => {
        listener = null;
      },
    };
  });
  const getInputCursorClientPosition = vi.fn(() => cursor);
  const fake = {
    subscribePtyData,
    getInputCursorClientPosition,
    emitPtyData() {
      if (listener) listener();
    },
  };
  return fake as unknown as TerminalRuntime & typeof fake;
}

describe("startInputCursorAttentionProducer", () => {
  it("emits input-cursor:typing target on pty data when caret is visible", () => {
    const attention = makeFakeAttention();
    const terminal = makeFakeTerminal({
      clientX: 50,
      clientY: 100,
      cellWidth: 8,
      cellHeight: 16,
    });
    const dispose = startInputCursorAttentionProducer({
      attention,
      terminal,
    });

    terminal.emitPtyData();

    const call = attention.setSourceTarget.mock.calls.find((c) => c[0] === "input-cursor:typing");
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({
      kind: "input-cursor",
      source: "input-cursor:typing",
      priority: 3,
      reason: "typing",
    });
    expect(call?.[1].rect).toMatchObject({ x: 50, y: 100, width: 8, height: 16 });
    dispose.dispose();
  });

  it("does not emit when caret position is null on first scan (virgin state)", () => {
    const attention = makeFakeAttention();
    const terminal = makeFakeTerminal(null);
    const dispose = startInputCursorAttentionProducer({
      attention,
      terminal,
    });

    terminal.emitPtyData();

    expect(attention.setSourceTarget).not.toHaveBeenCalled();
    dispose.dispose();
  });

  it("clears with null when caret was previously visible but now absent", () => {
    const attention = makeFakeAttention();
    let cursor: {
      clientX: number;
      clientY: number;
      cellWidth: number;
      cellHeight: number;
    } | null = { clientX: 50, clientY: 100, cellWidth: 8, cellHeight: 16 };
    let listener: (() => void) | null = null;
    const terminal = {
      subscribePtyData: vi.fn((l: () => void) => {
        listener = l;
        return {
          dispose: () => {
            listener = null;
          },
        };
      }),
      getInputCursorClientPosition: vi.fn(() => cursor),
    };
    const dispose = startInputCursorAttentionProducer({
      attention,
      terminal,
    });

    (listener as (() => void) | null)?.();
    // first scan: emitted typing target

    cursor = null;
    (listener as (() => void) | null)?.();
    // second scan: previously active → null clear

    const nullCall = attention.setSourceTarget.mock.calls.find(
      (c) => c[0] === "input-cursor:typing" && c[1] === null,
    );
    expect(nullCall).toBeDefined();
    dispose.dispose();
  });

  it("dispose unsubscribes from pty data listener", () => {
    const attention = makeFakeAttention();
    const ptyDispose = vi.fn();
    const terminal = {
      subscribePtyData: vi.fn(() => ({ dispose: ptyDispose })),
      getInputCursorClientPosition: vi.fn(() => null),
    };
    const handle = startInputCursorAttentionProducer({
      attention,
      terminal,
    });

    handle.dispose();
    expect(ptyDispose).toHaveBeenCalled();
  });
});

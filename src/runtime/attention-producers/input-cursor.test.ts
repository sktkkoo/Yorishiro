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

describe("input-cursor producer (sent / activate)", () => {
  it("emits input-cursor:sent on Enter keydown when no interactive element is focused", () => {
    vi.useFakeTimers();
    try {
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

      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      const call = attention.setSourceTarget.mock.calls.find((c) => c[0] === "input-cursor:sent");
      expect(call).toBeDefined();
      expect(call?.[1]).toMatchObject({
        kind: "input-cursor",
        source: "input-cursor:sent",
        priority: 5,
        reason: "sent",
      });

      // 600ms 後に null clear
      vi.advanceTimersByTime(700);
      const clearCall = attention.setSourceTarget.mock.calls.find(
        (c) => c[0] === "input-cursor:sent" && c[1] === null,
      );
      expect(clearCall).toBeDefined();
      dispose.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits input-cursor:activate when Enter pressed on a focused button", () => {
    vi.useFakeTimers();
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = () =>
      ({
        x: 10,
        y: 20,
        left: 10,
        top: 20,
        right: 110,
        bottom: 70,
        width: 100,
        height: 50,
        toJSON: () => ({}),
      }) as DOMRect;
    try {
      const button = document.createElement("button");
      document.body.appendChild(button);
      button.focus();

      const attention = makeFakeAttention();
      const terminal = makeFakeTerminal(null);
      const dispose = startInputCursorAttentionProducer({
        attention,
        terminal,
      });

      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      const call = attention.setSourceTarget.mock.calls.find(
        (c) => c[0] === "input-cursor:activate",
      );
      expect(call).toBeDefined();
      expect(call?.[1]).toMatchObject({
        source: "input-cursor:activate",
        priority: 5,
        reason: "activate",
      });

      vi.advanceTimersByTime(700);
      const clearCall = attention.setSourceTarget.mock.calls.find(
        (c) => c[0] === "input-cursor:activate" && c[1] === null,
      );
      expect(clearCall).toBeDefined();

      button.remove();
      dispose.dispose();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      vi.useRealTimers();
    }
  });

  it("dispose cancels pending sent/activate cleanup timers", () => {
    vi.useFakeTimers();
    try {
      const attention = makeFakeAttention();
      const terminal = makeFakeTerminal({
        clientX: 50,
        clientY: 100,
        cellWidth: 8,
        cellHeight: 16,
      });
      const handle = startInputCursorAttentionProducer({ attention, terminal });

      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      handle.dispose();

      const beforeAdvance = attention.setSourceTarget.mock.calls.length;
      vi.advanceTimersByTime(700);
      const afterAdvance = attention.setSourceTarget.mock.calls.length;
      // dispose 後は timer が cancel されるので新たな clear は呼ばれない
      expect(afterAdvance).toBe(beforeAdvance);
    } finally {
      vi.useRealTimers();
    }
  });
});

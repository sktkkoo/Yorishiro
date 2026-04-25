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
  const getInputCursorClientPosition = vi.fn(() => cursor);
  const fake = { getInputCursorClientPosition };
  return fake as unknown as TerminalRuntime & typeof fake;
}

// rAF stub ヘルパー：mockImplementation の closure への代入を
// オブジェクトプロパティ経由にすることで TypeScript CFA の never 収束を回避する。
function makeRafStub() {
  const state: { cb: ((t: DOMHighResTimeStamp) => void) | null } = { cb: null };
  const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
    state.cb = cb;
    return 1;
  });
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
  const tick = (t = performance.now()): void => {
    state.cb?.(t);
  };
  const restore = (): void => {
    rafSpy.mockRestore();
    vi.mocked(globalThis.cancelAnimationFrame).mockRestore?.();
  };
  return { rafSpy, tick, restore };
}

describe("startInputCursorAttentionProducer", () => {
  it("getInputCursorClientPosition は rAF 毎に呼ばれる", () => {
    // requestAnimationFrame をスタブし、手動で tick を制御する
    const { rafSpy, tick, restore } = makeRafStub();
    try {
      const attention = makeFakeAttention();
      const terminal = makeFakeTerminal({
        clientX: 50,
        clientY: 100,
        cellWidth: 8,
        cellHeight: 16,
      });
      const dispose = startInputCursorAttentionProducer({ attention, terminal });

      // 起動直後に 1 回 rAF が登録されている
      expect(rafSpy).toHaveBeenCalledTimes(1);
      expect(terminal.getInputCursorClientPosition).not.toHaveBeenCalled();

      // 1 frame 進める
      tick();
      expect(terminal.getInputCursorClientPosition).toHaveBeenCalledTimes(1);

      // 2 frame 目
      tick();
      expect(terminal.getInputCursorClientPosition).toHaveBeenCalledTimes(2);

      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("rAF tick で caret が visible なら input-cursor:typing を emit する", () => {
    const { tick, restore } = makeRafStub();
    try {
      const attention = makeFakeAttention();
      const terminal = makeFakeTerminal({
        clientX: 50,
        clientY: 100,
        cellWidth: 8,
        cellHeight: 16,
      });
      const dispose = startInputCursorAttentionProducer({ attention, terminal });

      tick();

      const call = attention.setSourceTarget.mock.calls.find((c) => c[0] === "input-cursor:typing");
      expect(call).toBeDefined();
      expect(call?.[1]).toMatchObject({
        kind: "input-cursor",
        source: "input-cursor:typing",
        priority: 5,
        reason: "typing",
      });
      expect(call?.[1].rect).toMatchObject({ x: 50, y: 100, width: 8, height: 16 });
      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("caret が null のとき最初の scan では emit しない (virgin state)", () => {
    const { tick, restore } = makeRafStub();
    try {
      const attention = makeFakeAttention();
      const terminal = makeFakeTerminal(null);
      const dispose = startInputCursorAttentionProducer({ attention, terminal });

      tick();

      expect(attention.setSourceTarget).not.toHaveBeenCalled();
      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("caret が visible → null に変化したとき null clear を emit する", () => {
    const { tick, restore } = makeRafStub();
    try {
      const attention = makeFakeAttention();
      let cursor: {
        clientX: number;
        clientY: number;
        cellWidth: number;
        cellHeight: number;
      } | null = { clientX: 50, clientY: 100, cellWidth: 8, cellHeight: 16 };
      const terminal = {
        getInputCursorClientPosition: vi.fn(() => cursor),
      };
      const dispose = startInputCursorAttentionProducer({ attention, terminal });

      // 1 frame 目: caret visible → typing emit
      tick();

      cursor = null;
      // 2 frame 目: caret absent → null clear
      tick();

      const nullCall = attention.setSourceTarget.mock.calls.find(
        (c) => c[0] === "input-cursor:typing" && c[1] === null,
      );
      expect(nullCall).toBeDefined();
      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("dispose で rAF がキャンセルされる", () => {
    const cancelSpy = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(() => 42);
    try {
      const attention = makeFakeAttention();
      const terminal = makeFakeTerminal(null);
      const handle = startInputCursorAttentionProducer({ attention, terminal });

      handle.dispose();
      expect(cancelSpy).toHaveBeenCalledWith(42);
    } finally {
      cancelSpy.mockRestore();
      vi.mocked(globalThis.requestAnimationFrame).mockRestore?.();
    }
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

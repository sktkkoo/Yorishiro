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

/**
 * subscribeHookSignal の fake を作成する。
 * 返した `emit` を呼ぶことで登録済み handler を全て発火できる。
 */
function makeHookSignalStub() {
  const handlers: Array<(event: { name: string }) => void> = [];
  const subscribeHookSignal = vi.fn((handler: (event: { name: string }) => void) => {
    handlers.push(handler);
    return { dispose: () => {} };
  });
  const emit = (name: string): void => {
    for (const h of handlers) h({ name });
  };
  return { subscribeHookSignal, emit };
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
      const { subscribeHookSignal } = makeHookSignalStub();
      const dispose = startInputCursorAttentionProducer({
        attention,
        terminal,
        subscribeHookSignal,
      });

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
      const { subscribeHookSignal } = makeHookSignalStub();
      const dispose = startInputCursorAttentionProducer({
        attention,
        terminal,
        subscribeHookSignal,
      });

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
      const { subscribeHookSignal } = makeHookSignalStub();
      const dispose = startInputCursorAttentionProducer({
        attention,
        terminal,
        subscribeHookSignal,
      });

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
      const { subscribeHookSignal } = makeHookSignalStub();
      const dispose = startInputCursorAttentionProducer({
        attention,
        terminal,
        subscribeHookSignal,
      });

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
      const { subscribeHookSignal } = makeHookSignalStub();
      const handle = startInputCursorAttentionProducer({
        attention,
        terminal,
        subscribeHookSignal,
      });

      handle.dispose();
      expect(cancelSpy).toHaveBeenCalledWith(42);
    } finally {
      cancelSpy.mockRestore();
      vi.mocked(globalThis.requestAnimationFrame).mockRestore?.();
    }
  });
});

describe("input-cursor producer (sent — hook-signal driven)", () => {
  it("user-prompt-submit hook-signal で input-cursor:sent を emit する", () => {
    vi.useFakeTimers();
    try {
      const attention = makeFakeAttention();
      const terminal = makeFakeTerminal({
        clientX: 50,
        clientY: 100,
        cellWidth: 8,
        cellHeight: 16,
      });
      const { subscribeHookSignal, emit } = makeHookSignalStub();
      const dispose = startInputCursorAttentionProducer({
        attention,
        terminal,
        subscribeHookSignal,
      });

      emit("user-prompt-submit");

      const call = attention.setSourceTarget.mock.calls.find((c) => c[0] === "input-cursor:sent");
      expect(call).toBeDefined();
      expect(call?.[1]).toMatchObject({
        kind: "input-cursor",
        source: "input-cursor:sent",
        priority: 5,
        reason: "sent",
      });
      expect(call?.[1].rect).toMatchObject({ x: 50, y: 100, width: 8, height: 16 });

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

  it("user-prompt-submit 以外の hook-signal では emit しない", () => {
    vi.useFakeTimers();
    try {
      const attention = makeFakeAttention();
      const terminal = makeFakeTerminal({
        clientX: 50,
        clientY: 100,
        cellWidth: 8,
        cellHeight: 16,
      });
      const { subscribeHookSignal, emit } = makeHookSignalStub();
      const dispose = startInputCursorAttentionProducer({
        attention,
        terminal,
        subscribeHookSignal,
      });

      emit("pre-tool-use");
      emit("stop");
      emit("notification");

      const call = attention.setSourceTarget.mock.calls.find((c) => c[0] === "input-cursor:sent");
      expect(call).toBeUndefined();
      dispose.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("getInputCursorClientPosition が null のとき submit しても emit しない", () => {
    vi.useFakeTimers();
    try {
      const attention = makeFakeAttention();
      // caret が取れない状態（直近 typing なし等）
      const terminal = makeFakeTerminal(null);
      const { subscribeHookSignal, emit } = makeHookSignalStub();
      const dispose = startInputCursorAttentionProducer({
        attention,
        terminal,
        subscribeHookSignal,
      });

      emit("user-prompt-submit");

      const call = attention.setSourceTarget.mock.calls.find((c) => c[0] === "input-cursor:sent");
      expect(call).toBeUndefined();
      dispose.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("600ms 後に pulse を null clear する", () => {
    vi.useFakeTimers();
    try {
      const attention = makeFakeAttention();
      const terminal = makeFakeTerminal({
        clientX: 10,
        clientY: 20,
        cellWidth: 8,
        cellHeight: 16,
      });
      const { subscribeHookSignal, emit } = makeHookSignalStub();
      const dispose = startInputCursorAttentionProducer({
        attention,
        terminal,
        subscribeHookSignal,
      });

      emit("user-prompt-submit");

      // 599ms では clear されていない
      vi.advanceTimersByTime(599);
      const earlyClear = attention.setSourceTarget.mock.calls.find(
        (c) => c[0] === "input-cursor:sent" && c[1] === null,
      );
      expect(earlyClear).toBeUndefined();

      // 600ms 経過で clear される
      vi.advanceTimersByTime(1);
      const clearCall = attention.setSourceTarget.mock.calls.find(
        (c) => c[0] === "input-cursor:sent" && c[1] === null,
      );
      expect(clearCall).toBeDefined();
      dispose.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("連続 submit で前の pulse timer をキャンセルして新しい pulse を emit する", () => {
    vi.useFakeTimers();
    try {
      const attention = makeFakeAttention();
      const terminal = makeFakeTerminal({
        clientX: 50,
        clientY: 100,
        cellWidth: 8,
        cellHeight: 16,
      });
      const { subscribeHookSignal, emit } = makeHookSignalStub();
      const dispose = startInputCursorAttentionProducer({
        attention,
        terminal,
        subscribeHookSignal,
      });

      // 1 回目 submit
      emit("user-prompt-submit");
      const firstEmitCount = attention.setSourceTarget.mock.calls.filter(
        (c) => c[0] === "input-cursor:sent" && c[1] !== null,
      ).length;
      expect(firstEmitCount).toBe(1);

      // 300ms 後（pulse 継続中）に 2 回目 submit
      vi.advanceTimersByTime(300);
      emit("user-prompt-submit");

      // さらに 600ms 後（2 回目 pulse のみ clear）
      vi.advanceTimersByTime(700);

      const sentEmits = attention.setSourceTarget.mock.calls.filter(
        (c) => c[0] === "input-cursor:sent" && c[1] !== null,
      );
      const clearEmits = attention.setSourceTarget.mock.calls.filter(
        (c) => c[0] === "input-cursor:sent" && c[1] === null,
      );
      // emit は 2 回、clear は 1 回（前の timer はキャンセルされた）
      expect(sentEmits).toHaveLength(2);
      expect(clearEmits).toHaveLength(1);
      dispose.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose で hookSub・rAF・pulse timer を全て cleanup する", () => {
    vi.useFakeTimers();
    const cancelSpy = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(() => 99);
    try {
      const attention = makeFakeAttention();
      const terminal = makeFakeTerminal({
        clientX: 50,
        clientY: 100,
        cellWidth: 8,
        cellHeight: 16,
      });
      const { subscribeHookSignal, emit } = makeHookSignalStub();
      const handle = startInputCursorAttentionProducer({
        attention,
        terminal,
        subscribeHookSignal,
      });

      emit("user-prompt-submit");

      // pulse 継続中に dispose
      handle.dispose();

      // rAF がキャンセルされている
      expect(cancelSpy).toHaveBeenCalledWith(99);

      // timer が cancel されているので 700ms 後も clear call が増えない
      const beforeAdvance = attention.setSourceTarget.mock.calls.length;
      vi.advanceTimersByTime(700);
      const afterAdvance = attention.setSourceTarget.mock.calls.length;
      expect(afterAdvance).toBe(beforeAdvance);
    } finally {
      cancelSpy.mockRestore();
      vi.mocked(globalThis.requestAnimationFrame).mockRestore?.();
      vi.useRealTimers();
    }
  });
});

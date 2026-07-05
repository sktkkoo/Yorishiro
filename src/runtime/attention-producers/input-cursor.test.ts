// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { AttentionRuntime } from "../attention-runtime/types";
import type { TerminalRuntime } from "../terminal-runtime/types";
import { INPUT_CURSOR_SCAN_INTERVAL_MS, startInputCursorAttentionProducer } from "./input-cursor";

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
  return { fake: fake as unknown as TerminalRuntime & typeof fake };
}

// rAF stub ヘルパー：mockImplementation の closure への代入を
// オブジェクトプロパティ経由にすることで TypeScript CFA の never 収束を回避する。
function makeRafStub() {
  const state: { cb: ((t: DOMHighResTimeStamp) => void) | null } = { cb: null };
  let now = 0;
  const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
    state.cb = cb;
    return 1;
  });
  const cancelSpy = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
  const tick = (t?: DOMHighResTimeStamp): void => {
    now = t ?? now + INPUT_CURSOR_SCAN_INTERVAL_MS;
    const cb = state.cb;
    state.cb = null;
    cb?.(now);
  };
  const restore = (): void => {
    rafSpy.mockRestore();
    cancelSpy.mockRestore();
  };
  return { cancelSpy, rafSpy, tick, restore };
}

function makeTimerStub() {
  const pending = new Map<number, { fn: () => void; fireAt: number }>();
  let nextId = 1;
  let now = 0;

  const setTimeoutFn = (fn: () => void, delay: number): unknown => {
    const id = nextId++;
    pending.set(id, { fn, fireAt: now + delay });
    return id;
  };

  const clearTimeoutFn = (id: unknown): void => {
    pending.delete(id as number);
  };

  const advance = (ms: number): void => {
    now += ms;
    for (const [id, entry] of [...pending]) {
      if (entry.fireAt <= now) {
        pending.delete(id);
        entry.fn();
      }
    }
  };

  return { setTimeoutFn, clearTimeoutFn, advance, pending };
}

function makeScanScheduler() {
  const raf = makeRafStub();
  const scanTimers = makeTimerStub();
  let firstScan = true;

  const runScan = (): void => {
    scanTimers.advance(firstScan ? 0 : INPUT_CURSOR_SCAN_INTERVAL_MS);
    firstScan = false;
    raf.tick();
  };

  return {
    ...raf,
    runScan,
    scanOptions: {
      setScanTimeout: scanTimers.setTimeoutFn,
      clearScanTimeout: scanTimers.clearTimeoutFn,
    },
    scanTimers,
  };
}

describe("startInputCursorAttentionProducer", () => {
  it("getInputCursorClientPosition は scan interval ごとに呼ばれる", () => {
    const { rafSpy, runScan, restore, scanOptions, scanTimers } = makeScanScheduler();
    try {
      const attention = makeFakeAttention();
      const { fake: terminal } = makeFakeTerminal({
        clientX: 50,
        clientY: 100,
        cellWidth: 8,
        cellHeight: 16,
      });
      const dispose = startInputCursorAttentionProducer({
        attention,
        terminal,
        ...scanOptions,
      });

      // 起動直後は scan timer だけが登録され、rAF はまだ走らない。
      expect(rafSpy).not.toHaveBeenCalled();
      expect(scanTimers.pending.size).toBe(1);
      expect(terminal.getInputCursorClientPosition).not.toHaveBeenCalled();

      // 初回 scan: timer 発火後の rAF でだけ走査する。
      runScan();
      expect(terminal.getInputCursorClientPosition).toHaveBeenCalledTimes(1);

      // interval 未満は次の rAF 自体を要求しない。
      scanTimers.advance(INPUT_CURSOR_SCAN_INTERVAL_MS - 1);
      expect(terminal.getInputCursorClientPosition).toHaveBeenCalledTimes(1);

      // interval 到達で次の scan
      runScan();
      expect(terminal.getInputCursorClientPosition).toHaveBeenCalledTimes(2);

      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("scan rAF で caret が visible なら input-cursor:typing を emit する", () => {
    const { runScan, restore, scanOptions } = makeScanScheduler();
    try {
      const attention = makeFakeAttention();
      const { fake: terminal } = makeFakeTerminal({
        clientX: 50,
        clientY: 100,
        cellWidth: 8,
        cellHeight: 16,
      });
      const dispose = startInputCursorAttentionProducer({
        attention,
        terminal,
        ...scanOptions,
      });

      runScan();

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
    const { runScan, restore, scanOptions } = makeScanScheduler();
    try {
      const attention = makeFakeAttention();
      const { fake: terminal } = makeFakeTerminal(null);
      const dispose = startInputCursorAttentionProducer({
        attention,
        terminal,
        ...scanOptions,
      });

      runScan();

      expect(attention.setSourceTarget).not.toHaveBeenCalled();
      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("caret が visible → null に変化したとき null clear を emit する", () => {
    const { runScan, restore, scanOptions } = makeScanScheduler();
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
      const dispose = startInputCursorAttentionProducer({
        attention,
        terminal,
        ...scanOptions,
      });

      // 1 frame 目: caret visible → typing emit
      runScan();

      cursor = null;
      // 2 frame 目: caret absent → null clear
      runScan();

      const nullCall = attention.setSourceTarget.mock.calls.find(
        (c) => c[0] === "input-cursor:typing" && c[1] === null,
      );
      expect(nullCall).toBeDefined();
      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("dispose で pending rAF がキャンセルされる", () => {
    const { cancelSpy, scanTimers, restore, scanOptions } = makeScanScheduler();
    try {
      const attention = makeFakeAttention();
      const { fake: terminal } = makeFakeTerminal(null);
      const handle = startInputCursorAttentionProducer({
        attention,
        terminal,
        ...scanOptions,
      });

      scanTimers.advance(0);
      handle.dispose();
      expect(cancelSpy).toHaveBeenCalledWith(1);
    } finally {
      restore();
    }
  });

  it("dispose 時に active な typing source を clear する", () => {
    const { runScan, restore, scanOptions } = makeScanScheduler();
    try {
      const attention = makeFakeAttention();
      const { fake: terminal } = makeFakeTerminal({
        clientX: 50,
        clientY: 100,
        cellWidth: 8,
        cellHeight: 16,
      });
      const handle = startInputCursorAttentionProducer({
        attention,
        terminal,
        ...scanOptions,
      });

      runScan();
      handle.dispose();

      const nullCall = attention.setSourceTarget.mock.calls.find(
        (c) => c[0] === "input-cursor:typing" && c[1] === null,
      );
      expect(nullCall).toBeDefined();
    } finally {
      restore();
    }
  });
});

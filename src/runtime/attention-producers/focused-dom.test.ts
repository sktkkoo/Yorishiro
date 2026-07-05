// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { AttentionRuntime } from "../attention-runtime/types";
import { FOCUSED_DOM_SCAN_INTERVAL_MS, startFocusedDomAttentionProducer } from "./focused-dom";

function makeFakeAttention() {
  const setSourceTarget = vi.fn();
  const get = vi.fn(() => ({ target: null }));
  const subscribe = vi.fn(() => ({ dispose: () => {} }));
  const fake = { setSourceTarget, get, subscribe };
  return fake as unknown as AttentionRuntime & typeof fake;
}

// input-cursor.test.ts と同様の rAF stub ヘルパー
function makeRafStub() {
  const state: { cb: ((t: DOMHighResTimeStamp) => void) | null } = { cb: null };
  let now = 0;
  const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
    state.cb = cb;
    return 1;
  });
  const cancelSpy = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
  const tick = (t?: DOMHighResTimeStamp): void => {
    now = t ?? now + FOCUSED_DOM_SCAN_INTERVAL_MS;
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
    scanTimers.advance(firstScan ? 0 : FOCUSED_DOM_SCAN_INTERVAL_MS);
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

describe("startFocusedDomAttentionProducer", () => {
  it("scan rAF で interesting な focus があれば focused-dom target を emit する", () => {
    const { runScan, restore, scanOptions } = makeScanScheduler();
    try {
      const attention = makeFakeAttention();
      const button = document.createElement("button");
      document.body.appendChild(button);

      // getBoundingClientRect を stub して有効な rect を返す
      button.getBoundingClientRect = () =>
        ({
          left: 50,
          top: 100,
          width: 120,
          height: 40,
          right: 170,
          bottom: 140,
          x: 50,
          y: 100,
          toJSON: () => ({}),
        }) as DOMRect;

      const dispose = startFocusedDomAttentionProducer({
        attention,
        getActiveElement: () => button,
        ...scanOptions,
      });

      runScan();

      const call = attention.setSourceTarget.mock.calls.find((c) => c[0] === "focused-dom");
      expect(call).toBeDefined();
      expect(call?.[1]).toMatchObject({
        kind: "focused-dom",
        source: "focused-dom",
        priority: 5,
        confidence: 0.7,
        reason: "focus",
      });
      // expand 10px が適用されている
      expect(call?.[1].rect).toMatchObject({ x: 40, y: 90, width: 140, height: 60 });

      button.remove();
      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("activeElement が null のとき emit しない", () => {
    const { runScan, restore, scanOptions } = makeScanScheduler();
    try {
      const attention = makeFakeAttention();
      const dispose = startFocusedDomAttentionProducer({
        attention,
        getActiveElement: () => null,
        ...scanOptions,
      });

      runScan();

      expect(attention.setSourceTarget).not.toHaveBeenCalled();
      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("activeElement が <body> のとき emit しない", () => {
    const { runScan, restore, scanOptions } = makeScanScheduler();
    try {
      const attention = makeFakeAttention();
      const dispose = startFocusedDomAttentionProducer({
        attention,
        getActiveElement: () => document.body,
        ...scanOptions,
      });

      runScan();

      expect(attention.setSourceTarget).not.toHaveBeenCalled();
      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("activeElement が .xterm 配下のとき emit しない", () => {
    const { runScan, restore, scanOptions } = makeScanScheduler();
    try {
      const attention = makeFakeAttention();

      const xterm = document.createElement("div");
      xterm.className = "xterm";
      const canvas = document.createElement("canvas");
      canvas.getBoundingClientRect = () =>
        ({
          left: 0,
          top: 0,
          width: 800,
          height: 400,
          right: 800,
          bottom: 400,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
      xterm.appendChild(canvas);
      document.body.appendChild(xterm);

      const dispose = startFocusedDomAttentionProducer({
        attention,
        getActiveElement: () => canvas,
        ...scanOptions,
      });

      runScan();

      expect(attention.setSourceTarget).not.toHaveBeenCalled();

      xterm.remove();
      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("activeElement の rect.width が 0 のとき emit しない", () => {
    const { runScan, restore, scanOptions } = makeScanScheduler();
    try {
      const attention = makeFakeAttention();
      const button = document.createElement("button");
      button.getBoundingClientRect = () =>
        ({
          left: 0,
          top: 0,
          width: 0,
          height: 40,
          right: 0,
          bottom: 40,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
      document.body.appendChild(button);

      const dispose = startFocusedDomAttentionProducer({
        attention,
        getActiveElement: () => button,
        ...scanOptions,
      });

      runScan();

      expect(attention.setSourceTarget).not.toHaveBeenCalled();

      button.remove();
      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("focus が消えたとき（前回 active → 今回 null）null clear を emit する", () => {
    const { runScan, restore, scanOptions } = makeScanScheduler();
    try {
      const attention = makeFakeAttention();
      const button = document.createElement("button");
      button.getBoundingClientRect = () =>
        ({
          left: 50,
          top: 100,
          width: 120,
          height: 40,
          right: 170,
          bottom: 140,
          x: 50,
          y: 100,
          toJSON: () => ({}),
        }) as DOMRect;
      document.body.appendChild(button);

      let active: Element | null = button;
      const dispose = startFocusedDomAttentionProducer({
        attention,
        getActiveElement: () => active,
        ...scanOptions,
      });

      // 1 frame 目: button に focus → emit
      runScan();

      // 2 frame 目: focus なし → null clear
      active = null;
      runScan();

      const clearCall = attention.setSourceTarget.mock.calls.find(
        (c) => c[0] === "focused-dom" && c[1] === null,
      );
      expect(clearCall).toBeDefined();

      button.remove();
      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("dispose で pending rAF がキャンセルされる", () => {
    const { cancelSpy, scanTimers, restore, scanOptions } = makeScanScheduler();
    try {
      const attention = makeFakeAttention();
      const handle = startFocusedDomAttentionProducer({
        attention,
        getActiveElement: () => null,
        ...scanOptions,
      });

      scanTimers.advance(0);
      handle.dispose();
      expect(cancelSpy).toHaveBeenCalledWith(1);
    } finally {
      restore();
    }
  });

  it("scan interval 待機中は rAF を再登録しない", () => {
    const { rafSpy, runScan, restore, scanOptions, scanTimers } = makeScanScheduler();
    try {
      const attention = makeFakeAttention();
      const dispose = startFocusedDomAttentionProducer({
        attention,
        getActiveElement: () => null,
        ...scanOptions,
      });

      // 起動直後は scan timer だけが登録され、rAF はまだ走らない。
      expect(rafSpy).not.toHaveBeenCalled();
      expect(scanTimers.pending.size).toBe(1);

      runScan();
      expect(rafSpy).toHaveBeenCalledTimes(1);

      scanTimers.advance(FOCUSED_DOM_SCAN_INTERVAL_MS - 1);
      expect(rafSpy).toHaveBeenCalledTimes(1);

      runScan();
      expect(rafSpy).toHaveBeenCalledTimes(2);

      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("scan interval 未満の frame では activeElement を読み直さない", () => {
    const { runScan, restore, scanOptions, scanTimers } = makeScanScheduler();
    try {
      const attention = makeFakeAttention();
      const getActiveElement = vi.fn(() => null);
      const dispose = startFocusedDomAttentionProducer({
        attention,
        getActiveElement,
        ...scanOptions,
      });

      runScan();
      expect(getActiveElement).toHaveBeenCalledTimes(1);

      scanTimers.advance(FOCUSED_DOM_SCAN_INTERVAL_MS - 1);
      expect(getActiveElement).toHaveBeenCalledTimes(1);

      runScan();
      expect(getActiveElement).toHaveBeenCalledTimes(2);

      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("dispose 時に active な focused-dom source を clear する", () => {
    const { runScan, restore, scanOptions } = makeScanScheduler();
    try {
      const attention = makeFakeAttention();
      const button = document.createElement("button");
      button.getBoundingClientRect = () =>
        ({
          left: 50,
          top: 100,
          width: 120,
          height: 40,
          right: 170,
          bottom: 140,
          x: 50,
          y: 100,
          toJSON: () => ({}),
        }) as DOMRect;
      document.body.appendChild(button);

      const handle = startFocusedDomAttentionProducer({
        attention,
        getActiveElement: () => button,
        ...scanOptions,
      });

      runScan();
      handle.dispose();

      const clearCall = attention.setSourceTarget.mock.calls.find(
        (c) => c[0] === "focused-dom" && c[1] === null,
      );
      expect(clearCall).toBeDefined();

      button.remove();
    } finally {
      restore();
    }
  });
});

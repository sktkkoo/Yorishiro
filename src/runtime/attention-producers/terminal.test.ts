// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { AttentionRuntime } from "../attention-runtime/types";
import type { TerminalRuntime } from "../terminal-runtime/types";
import { startTerminalAttentionProducer, TERMINAL_ATTENTION_SCAN_INTERVAL_MS } from "./terminal";

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
  const getViewportLineRects = vi.fn(() => lines);
  const fake = { getViewportLineRects };
  return fake as unknown as TerminalRuntime & typeof fake;
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
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
  const tick = (t?: DOMHighResTimeStamp): void => {
    now = t ?? now + TERMINAL_ATTENTION_SCAN_INTERVAL_MS;
    const cb = state.cb;
    state.cb = null;
    cb?.(now);
  };
  const restore = (): void => {
    rafSpy.mockRestore();
    vi.mocked(globalThis.cancelAnimationFrame).mockRestore?.();
  };
  return { rafSpy, tick, restore, state };
}

/**
 * setTimeout / clearTimeout の手動制御スタブ。
 * vi.useFakeTimers() は requestAnimationFrame をグローバルから除去するため、
 * rAF spy と共存できない。producer の DI 注入口を使って直接制御する。
 * ID は number で管理し、StartOptions の unknown 型インターフェースに適合する。
 */
function makeTimerStub() {
  const pending = new Map<number, { fn: () => void; delay: number; fireAt: number }>();
  let nextId = 1;
  let now = 0;

  const setTimeoutFn = (fn: () => void, delay: number): unknown => {
    const id = nextId++;
    pending.set(id, { fn, delay, fireAt: now + delay });
    return id;
  };

  const clearTimeoutFn = (id: unknown): void => {
    pending.delete(id as number);
  };

  /** 指定 ms だけ時刻を進め、発火すべき timer を全て実行する */
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
    scanTimers.advance(firstScan ? 0 : TERMINAL_ATTENTION_SCAN_INTERVAL_MS);
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

describe("startTerminalAttentionProducer", () => {
  it("getViewportLineRects は scan interval ごとに呼ばれる", () => {
    const { rafSpy, runScan, restore, scanOptions, scanTimers } = makeScanScheduler();
    try {
      const attention = makeFakeAttention();
      const terminal = makeFakeTerminal([]);
      const dispose = startTerminalAttentionProducer({ attention, terminal, ...scanOptions });

      // 起動直後は scan timer だけが登録され、rAF はまだ走らない。
      expect(rafSpy).not.toHaveBeenCalled();
      expect(scanTimers.pending.size).toBe(1);
      expect(terminal.getViewportLineRects).not.toHaveBeenCalled();

      // 初回 scan: timer 発火後の rAF でだけ走査する。
      runScan();
      expect(terminal.getViewportLineRects).toHaveBeenCalledTimes(1);

      // interval 未満は次の rAF 自体を要求しない。
      scanTimers.advance(TERMINAL_ATTENTION_SCAN_INTERVAL_MS - 1);
      expect(terminal.getViewportLineRects).toHaveBeenCalledTimes(1);

      // interval 到達で次の scan
      runScan();
      expect(terminal.getViewportLineRects).toHaveBeenCalledTimes(2);

      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("新規 diagnostic 行が現れた frame のみ terminal:diagnostic を emit する", () => {
    const { runScan, restore, scanOptions } = makeScanScheduler();
    const timers = makeTimerStub();
    try {
      const attention = makeFakeAttention();
      // getViewportLineRects は bottom-first 順で返す（index 0 = 最下行）
      const terminal = makeFakeTerminal([
        { text: "Error: build failed", rect: { x: 10, y: 100, width: 200, height: 16 } },
      ]);
      const dispose = startTerminalAttentionProducer({
        attention,
        terminal,
        setTimeout: timers.setTimeoutFn,
        clearTimeout: timers.clearTimeoutFn,
        ...scanOptions,
      });

      // frame N: 新規行 → emit される
      runScan();
      const callsAfterFrame1 = attention.setSourceTarget.mock.calls.filter(
        (c) => c[0] === "terminal:diagnostic" && c[1] !== null,
      );
      expect(callsAfterFrame1).toHaveLength(1);
      expect(callsAfterFrame1[0]?.[1]).toMatchObject({
        kind: "terminal-region",
        source: "terminal:diagnostic",
        priority: 8,
        reason: "diagnostic",
      });

      // frame N+1: 同一行がまだ viewport に存在 → 再 emit しない
      attention.setSourceTarget.mockClear();
      runScan();
      const callsAfterFrame2 = attention.setSourceTarget.mock.calls.filter(
        (c) => c[0] === "terminal:diagnostic" && c[1] !== null,
      );
      expect(callsAfterFrame2).toHaveLength(0);

      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("新規 file-link 行が現れた frame のみ terminal:file-link を emit する", () => {
    const { runScan, restore, scanOptions } = makeScanScheduler();
    const timers = makeTimerStub();
    try {
      const attention = makeFakeAttention();
      const terminal = makeFakeTerminal([
        { text: "src/App.tsx:12", rect: { x: 10, y: 80, width: 200, height: 16 } },
      ]);
      const dispose = startTerminalAttentionProducer({
        attention,
        terminal,
        setTimeout: timers.setTimeoutFn,
        clearTimeout: timers.clearTimeoutFn,
        ...scanOptions,
      });

      // frame N: 新規行 → emit
      runScan();
      const callsAfterFrame1 = attention.setSourceTarget.mock.calls.filter(
        (c) => c[0] === "terminal:file-link" && c[1] !== null,
      );
      expect(callsAfterFrame1).toHaveLength(1);
      expect(callsAfterFrame1[0]?.[1]).toMatchObject({
        kind: "terminal-region",
        source: "terminal:file-link",
        priority: 5,
        reason: "file-link",
      });

      // frame N+1: 同一行がまだ存在 → 再 emit しない
      attention.setSourceTarget.mockClear();
      runScan();
      expect(
        attention.setSourceTarget.mock.calls.filter(
          (c) => c[0] === "terminal:file-link" && c[1] !== null,
        ),
      ).toHaveLength(0);

      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("emit する rect は runtime の再利用バッファを参照せず複製する", () => {
    const { runScan, restore, scanOptions } = makeScanScheduler();
    const timers = makeTimerStub();
    try {
      const attention = makeFakeAttention();
      const pooledRect = { x: 10, y: 100, width: 200, height: 16 };
      const terminal = makeFakeTerminal([{ text: "Error: build failed", rect: pooledRect }]);
      const dispose = startTerminalAttentionProducer({
        attention,
        terminal,
        setTimeout: timers.setTimeoutFn,
        clearTimeout: timers.clearTimeoutFn,
        ...scanOptions,
      });

      runScan();
      const call = attention.setSourceTarget.mock.calls.find(
        (c) => c[0] === "terminal:diagnostic" && c[1] !== null,
      );
      expect(call?.[1].rect).not.toBe(pooledRect);
      expect(call?.[1].rect).toEqual(pooledRect);

      // getViewportLineRects() の pool が次 scan で in-place 上書きされても
      // 発行済み target の rect は変わらない
      pooledRect.y = 999;
      expect(call?.[1].rect.y).toBe(100);

      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("recent-output 行（意味マーカーなし）は emit しない", () => {
    const { runScan, restore, scanOptions } = makeScanScheduler();
    try {
      const attention = makeFakeAttention();
      const terminal = makeFakeTerminal([
        { text: "Listening on port 1430", rect: { x: 10, y: 60, width: 200, height: 16 } },
      ]);
      const dispose = startTerminalAttentionProducer({ attention, terminal, ...scanOptions });

      runScan();

      expect(attention.setSourceTarget).not.toHaveBeenCalled();
      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("viewport に diagnostic と file-link の両方が新規に現れた場合は並列 emit する", () => {
    const { runScan, restore, scanOptions } = makeScanScheduler();
    const timers = makeTimerStub();
    try {
      const attention = makeFakeAttention();
      // bottom-first: index 0 が最下行（diagnostic）、index 1 が上の行（file-link）
      const terminal = makeFakeTerminal([
        { text: "Error: build failed", rect: { x: 10, y: 100, width: 200, height: 16 } },
        { text: "src/App.tsx:12", rect: { x: 10, y: 50, width: 200, height: 16 } },
      ]);
      const dispose = startTerminalAttentionProducer({
        attention,
        terminal,
        setTimeout: timers.setTimeoutFn,
        clearTimeout: timers.clearTimeoutFn,
        ...scanOptions,
      });

      runScan();

      const diagnosticCall = attention.setSourceTarget.mock.calls.find(
        (c) => c[0] === "terminal:diagnostic" && c[1] !== null,
      );
      const fileLinkCall = attention.setSourceTarget.mock.calls.find(
        (c) => c[0] === "terminal:file-link" && c[1] !== null,
      );
      expect(diagnosticCall).toBeDefined();
      expect(fileLinkCall).toBeDefined();
      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("diagnostic 行が viewport から消えた frame では null clear しない（pulse timer が管理する）", () => {
    const { runScan, restore, scanOptions } = makeScanScheduler();
    const timers = makeTimerStub();
    try {
      const attention = makeFakeAttention();
      const lines: Array<{
        text: string;
        rect: { x: number; y: number; width: number; height: number };
      }> = [{ text: "Error: build failed", rect: { x: 10, y: 100, width: 200, height: 16 } }];
      const terminal = makeFakeTerminal(lines);
      const dispose = startTerminalAttentionProducer({
        attention,
        terminal,
        setTimeout: timers.setTimeoutFn,
        clearTimeout: timers.clearTimeoutFn,
        ...scanOptions,
      });

      // frame N: 新規 diagnostic → emit
      runScan();

      // viewport から diagnostic が消えた状態をシミュレート
      lines.length = 0;
      lines.push({ text: "OK", rect: { x: 10, y: 100, width: 200, height: 16 } });

      attention.setSourceTarget.mockClear();
      // frame N+1: 行が消えても rAF tick 内では null clear しない（timer が担当）
      runScan();

      // pulse timer（3000ms）はまだ発火していないので null clear は呼ばれていない
      const nullCall = attention.setSourceTarget.mock.calls.find(
        (c) => c[0] === "terminal:diagnostic" && c[1] === null,
      );
      expect(nullCall).toBeUndefined();

      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("行が viewport から消えて再度現れたとき再 emit する", () => {
    const { runScan, restore, scanOptions } = makeScanScheduler();
    const timers = makeTimerStub();
    try {
      const attention = makeFakeAttention();
      const lines: Array<{
        text: string;
        rect: { x: number; y: number; width: number; height: number };
      }> = [{ text: "Error: build failed", rect: { x: 10, y: 100, width: 200, height: 16 } }];
      const terminal = makeFakeTerminal(lines);
      const dispose = startTerminalAttentionProducer({
        attention,
        terminal,
        setTimeout: timers.setTimeoutFn,
        clearTimeout: timers.clearTimeoutFn,
        ...scanOptions,
      });

      // frame N: 新規行 → emit
      runScan();

      // viewport から消える
      lines.length = 0;
      // frame N+1: 空 → seen Set もクリアされる
      runScan();

      // 再度現れる
      lines.push({ text: "Error: build failed", rect: { x: 10, y: 100, width: 200, height: 16 } });

      attention.setSourceTarget.mockClear();
      // frame N+2: seen には存在しない → 再 emit される
      runScan();

      const reEmitCall = attention.setSourceTarget.mock.calls.find(
        (c) => c[0] === "terminal:diagnostic" && c[1] !== null,
      );
      expect(reEmitCall).toBeDefined();

      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("pulse timer が 3000ms 後に発火して source を null clear する", () => {
    const { runScan, restore, scanOptions } = makeScanScheduler();
    const timers = makeTimerStub();
    try {
      const attention = makeFakeAttention();
      const terminal = makeFakeTerminal([
        { text: "Error: build failed", rect: { x: 10, y: 100, width: 200, height: 16 } },
      ]);
      const dispose = startTerminalAttentionProducer({
        attention,
        terminal,
        setTimeout: timers.setTimeoutFn,
        clearTimeout: timers.clearTimeoutFn,
        ...scanOptions,
      });

      // frame N: emit + timer 開始
      runScan();

      // timer 発火前は null clear なし
      timers.advance(2999);
      expect(
        attention.setSourceTarget.mock.calls.find(
          (c) => c[0] === "terminal:diagnostic" && c[1] === null,
        ),
      ).toBeUndefined();

      // 3000ms で発火
      timers.advance(1);
      const nullCall = attention.setSourceTarget.mock.calls.find(
        (c) => c[0] === "terminal:diagnostic" && c[1] === null,
      );
      expect(nullCall).toBeDefined();

      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("pulse 中に新規行が来たとき既存 timer をキャンセルして新 timer を開始する", () => {
    const { runScan, restore, scanOptions } = makeScanScheduler();
    const timers = makeTimerStub();
    try {
      const attention = makeFakeAttention();
      const lines: Array<{
        text: string;
        rect: { x: number; y: number; width: number; height: number };
      }> = [{ text: "Error: first error", rect: { x: 10, y: 100, width: 200, height: 16 } }];
      const terminal = makeFakeTerminal(lines);
      const dispose = startTerminalAttentionProducer({
        attention,
        terminal,
        setTimeout: timers.setTimeoutFn,
        clearTimeout: timers.clearTimeoutFn,
        ...scanOptions,
      });

      // frame N: 最初の diagnostic → emit + timer_1 開始
      runScan();

      // 1500ms 経過（timer_1 まだ生存中）
      timers.advance(1500);

      // viewport が変わって別の diagnostic 行が出現（前の行は消えたとする）
      lines.length = 0;
      lines.push({ text: "Error: second error", rect: { x: 10, y: 100, width: 200, height: 16 } });

      attention.setSourceTarget.mockClear();
      // frame N+1: 新規行 → emit + timer_1 cancel + timer_2 開始
      runScan();

      // 新しい emit が来ているはず
      const newEmit = attention.setSourceTarget.mock.calls.find(
        (c) => c[0] === "terminal:diagnostic" && c[1] !== null,
      );
      expect(newEmit).toBeDefined();

      // timer_1 がキャンセルされたので元の残り時間 1500ms 経過では発火しない
      attention.setSourceTarget.mockClear();
      timers.advance(1500);
      expect(
        attention.setSourceTarget.mock.calls.find(
          (c) => c[0] === "terminal:diagnostic" && c[1] === null,
        ),
      ).toBeUndefined();

      // timer_2 の 3000ms（frame N+1 から）で発火する
      timers.advance(1500); // 合計 3000ms 到達
      const nullCall = attention.setSourceTarget.mock.calls.find(
        (c) => c[0] === "terminal:diagnostic" && c[1] === null,
      );
      expect(nullCall).toBeDefined();

      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("dispose で rAF と全 pulse timer がキャンセルされる", () => {
    const { runScan, restore, scanOptions, scanTimers } = makeScanScheduler();
    const timers = makeTimerStub();
    try {
      const attention = makeFakeAttention();
      const terminal = makeFakeTerminal([
        { text: "Error: build failed", rect: { x: 10, y: 100, width: 200, height: 16 } },
      ]);
      const handle = startTerminalAttentionProducer({
        attention,
        terminal,
        setTimeout: timers.setTimeoutFn,
        clearTimeout: timers.clearTimeoutFn,
        ...scanOptions,
      });

      // 1 tick 走らせて pulse timer を開始する
      runScan();
      expect(timers.pending.size).toBe(1); // timer が登録されている
      expect(scanTimers.pending.size).toBe(1); // 次の scan timer が登録されている

      handle.dispose();

      // dispose 後は pending timer が全て削除されている（cancel済み）
      expect(timers.pending.size).toBe(0);
      expect(scanTimers.pending.size).toBe(0);

      // dispose 後に timer を advance しても新たな setSourceTarget 呼び出しがない
      const callsAtDispose = attention.setSourceTarget.mock.calls.length;
      timers.advance(3000);
      expect(attention.setSourceTarget.mock.calls.length).toBe(callsAtDispose);
    } finally {
      restore();
    }
  });

  it("dispose 後は pending rAF が来ても scan しない", () => {
    const { tick, runScan, restore, scanOptions, scanTimers } = makeScanScheduler();
    try {
      const attention = makeFakeAttention();
      const terminal = makeFakeTerminal([
        { text: "Error: build failed", rect: { x: 10, y: 100, width: 200, height: 16 } },
      ]);
      const handle = startTerminalAttentionProducer({ attention, terminal, ...scanOptions });

      // 1 frame 目: emit される
      runScan();
      const countAfterFirstTick = terminal.getViewportLineRects.mock.calls.length;

      // 次 scan の timer を rAF 登録まで進め、その rAF が来る前に dispose する。
      scanTimers.advance(TERMINAL_ATTENTION_SCAN_INTERVAL_MS);
      handle.dispose();

      // dispose 後に古い callback が呼ばれても scan しない。
      tick();
      expect(terminal.getViewportLineRects.mock.calls.length).toBe(countAfterFirstTick);
    } finally {
      restore();
    }
  });

  it("viewport が空になると seen Set がリセットされる（次回の行出現で再 emit 可能）", () => {
    const { runScan, restore, scanOptions } = makeScanScheduler();
    const timers = makeTimerStub();
    try {
      const attention = makeFakeAttention();
      const lines: Array<{
        text: string;
        rect: { x: number; y: number; width: number; height: number };
      }> = [{ text: "Error: build failed", rect: { x: 10, y: 100, width: 200, height: 16 } }];
      const terminal = makeFakeTerminal(lines);
      const dispose = startTerminalAttentionProducer({
        attention,
        terminal,
        setTimeout: timers.setTimeoutFn,
        clearTimeout: timers.clearTimeoutFn,
        ...scanOptions,
      });

      runScan(); // frame 1: emit
      lines.length = 0;
      runScan(); // frame 2: viewport empty → seen Set clear

      // 同一テキストの行が再度現れる
      lines.push({ text: "Error: build failed", rect: { x: 10, y: 200, width: 200, height: 16 } });
      attention.setSourceTarget.mockClear();
      runScan(); // frame 3: 再 emit されるはず

      const reEmit = attention.setSourceTarget.mock.calls.find(
        (c) => c[0] === "terminal:diagnostic" && c[1] !== null,
      );
      expect(reEmit).toBeDefined();

      dispose.dispose();
    } finally {
      restore();
    }
  });
});

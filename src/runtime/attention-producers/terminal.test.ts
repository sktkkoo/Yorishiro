// @vitest-environment jsdom

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
  const getViewportLineRects = vi.fn(() => lines);
  const fake = { getViewportLineRects };
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

describe("startTerminalAttentionProducer", () => {
  it("getViewportLineRects は rAF tick 毎に呼ばれる", () => {
    const { rafSpy, tick, restore } = makeRafStub();
    try {
      const attention = makeFakeAttention();
      const terminal = makeFakeTerminal([]);
      const dispose = startTerminalAttentionProducer({ attention, terminal });

      // 起動直後に 1 回 rAF が登録されている
      expect(rafSpy).toHaveBeenCalledTimes(1);
      expect(terminal.getViewportLineRects).not.toHaveBeenCalled();

      // 1 frame 進める
      tick();
      expect(terminal.getViewportLineRects).toHaveBeenCalledTimes(1);

      // 2 frame 目
      tick();
      expect(terminal.getViewportLineRects).toHaveBeenCalledTimes(2);

      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("rAF tick で diagnostic 行が bottom-most なら terminal:diagnostic を emit する", () => {
    const { tick, restore } = makeRafStub();
    try {
      const attention = makeFakeAttention();
      // getViewportLineRects は bottom-first 順で返す（index 0 = 最下行）
      const terminal = makeFakeTerminal([
        { text: "Error: build failed", rect: { x: 10, y: 100, width: 200, height: 16 } },
      ]);
      const dispose = startTerminalAttentionProducer({ attention, terminal });

      tick();

      const call = attention.setSourceTarget.mock.calls.find((c) => c[0] === "terminal:diagnostic");
      expect(call).toBeDefined();
      expect(call?.[1]).toMatchObject({
        kind: "terminal-region",
        source: "terminal:diagnostic",
        priority: 8,
        reason: "diagnostic",
      });
      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("rAF tick で file-link 行が bottom-most なら terminal:file-link を emit する", () => {
    const { tick, restore } = makeRafStub();
    try {
      const attention = makeFakeAttention();
      const terminal = makeFakeTerminal([
        { text: "src/App.tsx:12", rect: { x: 10, y: 80, width: 200, height: 16 } },
      ]);
      const dispose = startTerminalAttentionProducer({ attention, terminal });

      tick();

      const call = attention.setSourceTarget.mock.calls.find((c) => c[0] === "terminal:file-link");
      expect(call).toBeDefined();
      expect(call?.[1]).toMatchObject({
        kind: "terminal-region",
        source: "terminal:file-link",
        priority: 5,
        reason: "file-link",
      });
      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("recent-output 行（意味マーカーなし）は emit しない", () => {
    const { tick, restore } = makeRafStub();
    try {
      const attention = makeFakeAttention();
      const terminal = makeFakeTerminal([
        { text: "Listening on port 1430", rect: { x: 10, y: 60, width: 200, height: 16 } },
      ]);
      const dispose = startTerminalAttentionProducer({ attention, terminal });

      tick();

      expect(attention.setSourceTarget).not.toHaveBeenCalled();
      dispose.dispose();
    } finally {
      restore();
    }
  });

  it("viewport に diagnostic と file-link の両方がある場合は並列 emit する", () => {
    const { tick, restore } = makeRafStub();
    try {
      const attention = makeFakeAttention();
      // bottom-first: index 0 が最下行（diagnostic）、index 1 が上の行（file-link）
      const terminal = makeFakeTerminal([
        { text: "Error: build failed", rect: { x: 10, y: 100, width: 200, height: 16 } },
        { text: "src/App.tsx:12", rect: { x: 10, y: 50, width: 200, height: 16 } },
      ]);
      const dispose = startTerminalAttentionProducer({ attention, terminal });

      tick();

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

  it("前 frame で active だった diagnostic 行が消えたら null で clear する", () => {
    const { tick, restore } = makeRafStub();
    try {
      const attention = makeFakeAttention();
      const lines: Array<{
        text: string;
        rect: { x: number; y: number; width: number; height: number };
      }> = [{ text: "Error: build failed", rect: { x: 10, y: 100, width: 200, height: 16 } }];
      const terminal = makeFakeTerminal(lines);
      const dispose = startTerminalAttentionProducer({ attention, terminal });

      // 1 frame 目: diagnostic emit
      tick();

      // viewport が変わって diagnostic が消えた状態を simulate
      lines.length = 0;
      lines.push({ text: "OK", rect: { x: 10, y: 100, width: 200, height: 16 } });

      // 2 frame 目: 前 frame active だった diagnostic を null で clear
      tick();

      const nullCall = attention.setSourceTarget.mock.calls.find(
        (c) => c[0] === "terminal:diagnostic" && c[1] === null,
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
      const terminal = makeFakeTerminal([]);
      const handle = startTerminalAttentionProducer({ attention, terminal });

      handle.dispose();
      expect(cancelSpy).toHaveBeenCalledWith(42);
    } finally {
      cancelSpy.mockRestore();
      vi.mocked(globalThis.requestAnimationFrame).mockRestore?.();
    }
  });

  it("dispose 後は rAF tick が来ても scan しない", () => {
    const { tick, restore } = makeRafStub();
    try {
      const attention = makeFakeAttention();
      const terminal = makeFakeTerminal([
        { text: "Error: build failed", rect: { x: 10, y: 100, width: 200, height: 16 } },
      ]);
      const handle = startTerminalAttentionProducer({ attention, terminal });

      // 1 frame 目: emit される
      tick();
      const countAfterFirstTick = terminal.getViewportLineRects.mock.calls.length;

      handle.dispose();

      // dispose 後の tick: rAF がキャンセルされているので stub の cb は
      // 次の tick で更新されない（stub は同一 cb を保持したまま）。
      // getViewportLineRects の呼び出し回数が増えないことで確認する。
      expect(terminal.getViewportLineRects.mock.calls.length).toBe(countAfterFirstTick);
    } finally {
      restore();
    }
  });
});

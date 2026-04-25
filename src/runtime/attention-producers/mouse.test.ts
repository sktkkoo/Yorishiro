// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionRuntime } from "../attention-runtime/types";
import { startMouseAttentionProducer } from "./mouse";

// テスト用 fake attention
function makeFakeAttention() {
  const setSourceTarget = vi.fn();
  const get = vi.fn(() => ({ target: null }));
  const subscribe = vi.fn(() => ({ dispose: () => {} }));
  const fake = { setSourceTarget, get, subscribe };
  return fake as unknown as AttentionRuntime & typeof fake;
}

// 決定論的な timer stub
function makeTimerStub() {
  let nextId = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    set: vi.fn((fn: () => void, ms: number): number => {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    }),
    clear: vi.fn((id: number) => {
      pending.delete(id);
    }),
    /** 登録されている全タイマーを即時発火する */
    flush: () => {
      for (const [id, { fn }] of [...pending]) {
        pending.delete(id);
        fn();
      }
    },
    pending,
  };
}

describe("startMouseAttentionProducer", () => {
  let attention: ReturnType<typeof makeFakeAttention>;
  let timer: ReturnType<typeof makeTimerStub>;
  let currentNow: number;

  beforeEach(() => {
    attention = makeFakeAttention();
    timer = makeTimerStub();
    currentNow = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── pointerdown: active window を開いて rect を emit ──────────────────

  it("pointerdown が active window を開き、ポインタ座標の 20×20 rect を emit する", () => {
    const dispose = startMouseAttentionProducer({
      attention,
      random: () => 0, // duration = 1.0 秒
      timer,
      now: () => currentNow,
    });

    window.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 100, clientY: 200, bubbles: true }),
    );

    const calls = attention.setSourceTarget.mock.calls.filter((c) => c[0] === "mouse");
    expect(calls).toHaveLength(1);
    const [, target] = calls[0];
    expect(target).toMatchObject({
      kind: "mouse",
      source: "mouse",
      priority: 9,
      confidence: 0.9,
      reason: "cursor-attention:mouse-click",
    });
    expect(target.rect).toMatchObject({ x: 90, y: 190, width: 20, height: 20 });

    dispose.dispose();
  });

  it("pointerdown の duration は random 1.0〜3.0 秒の範囲に収まる", () => {
    // random() = 0 → duration = 1.0 s
    const timer1 = makeTimerStub();
    const d1 = startMouseAttentionProducer({
      attention: makeFakeAttention(),
      random: () => 0,
      timer: timer1,
      now: () => 0,
    });
    window.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 0, clientY: 0, bubbles: true }),
    );
    expect(timer1.set.mock.calls[0][1]).toBeCloseTo(1000, 0);
    d1.dispose();

    // random() = 1 → duration = 3.0 s
    const timer3 = makeTimerStub();
    const d3 = startMouseAttentionProducer({
      attention: makeFakeAttention(),
      random: () => 1,
      timer: timer3,
      now: () => 0,
    });
    window.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 0, clientY: 0, bubbles: true }),
    );
    expect(timer3.set.mock.calls[0][1]).toBeCloseTo(3000, 0);
    d3.dispose();
  });

  // ── pointermove: active window 中のみ rect を更新 ─────────────────────

  it("active window 中の pointermove は rect を追従更新する", () => {
    currentNow = 0;
    const dispose = startMouseAttentionProducer({
      attention,
      random: () => 0.5, // duration = 2.0 秒
      timer,
      now: () => currentNow,
    });

    // pointerdown で active window を開く (activeUntil = 2000ms)
    window.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 50, clientY: 50, bubbles: true }),
    );
    attention.setSourceTarget.mockClear();

    // 1000ms 後 (active window 内) に pointermove
    currentNow = 1000;
    window.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 300, clientY: 400, bubbles: true }),
    );

    const calls = attention.setSourceTarget.mock.calls.filter((c) => c[0] === "mouse");
    expect(calls).toHaveLength(1);
    expect(calls[0][1].rect).toMatchObject({ x: 290, y: 390, width: 20, height: 20 });

    dispose.dispose();
  });

  it("active window 外の pointermove は emit しない", () => {
    currentNow = 0;
    const dispose = startMouseAttentionProducer({
      attention,
      random: () => 0, // duration = 1.0 秒 → activeUntil = 1000ms
      timer,
      now: () => currentNow,
    });

    window.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 50, clientY: 50, bubbles: true }),
    );
    attention.setSourceTarget.mockClear();

    // active window を超えた時刻で pointermove
    currentNow = 1500;
    window.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 200, clientY: 200, bubbles: true }),
    );

    // emit なし
    expect(attention.setSourceTarget).not.toHaveBeenCalled();

    dispose.dispose();
  });

  // ── active window 満了: source を null clear ─────────────────────────

  it("active window 満了タイマー発火で setSourceTarget('mouse', null) を呼ぶ", () => {
    currentNow = 0;
    const dispose = startMouseAttentionProducer({
      attention,
      random: () => 0, // 1.0 秒
      timer,
      now: () => currentNow,
    });

    window.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 0, clientY: 0, bubbles: true }),
    );
    attention.setSourceTarget.mockClear();

    // タイマーを手動で発火
    timer.flush();

    expect(attention.setSourceTarget).toHaveBeenCalledWith("mouse", null);

    dispose.dispose();
  });

  // ── re-click: active window をリセット ──────────────────────────────

  it("2 回目の pointerdown は既存タイマーをキャンセルして window をリセットする", () => {
    currentNow = 0;
    const dispose = startMouseAttentionProducer({
      attention,
      random: () => 0.5, // 2.0 秒
      timer,
      now: () => currentNow,
    });

    window.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 0, clientY: 0, bubbles: true }),
    );
    const firstTimerId = [...timer.pending.keys()][0];

    // 500ms 後に再クリック
    currentNow = 500;
    window.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 10, clientY: 10, bubbles: true }),
    );

    // 最初のタイマーがキャンセルされている
    expect(timer.clear).toHaveBeenCalledWith(firstTimerId);
    // 新しいタイマーが登録されている
    expect(timer.pending.size).toBe(1);

    dispose.dispose();
  });

  // ── dispose: listener 解除 + timer cancel + source null clear ────────

  it("dispose は listener を外し、タイマーをキャンセルし、source を null clear する", () => {
    currentNow = 0;
    const dispose = startMouseAttentionProducer({
      attention,
      random: () => 0.5,
      timer,
      now: () => currentNow,
    });

    window.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 50, clientY: 50, bubbles: true }),
    );
    const timerId = [...timer.pending.keys()][0];
    attention.setSourceTarget.mockClear();

    dispose.dispose();

    // タイマーがキャンセルされている
    expect(timer.clear).toHaveBeenCalledWith(timerId);
    // source が null clear されている
    expect(attention.setSourceTarget).toHaveBeenCalledWith("mouse", null);

    // dispose 後の pointerdown / pointermove は emit しない
    attention.setSourceTarget.mockClear();
    window.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 0, clientY: 0, bubbles: true }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 0, clientY: 0, bubbles: true }),
    );
    expect(attention.setSourceTarget).not.toHaveBeenCalled();
  });

  // ── interactive element: bounding rect を使う ────────────────────────

  it("pointerdown target が interactive 要素かつ bounding rect 有効ならその rect を使う", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    // jsdom ではレイアウトが無いため getBoundingClientRect は 0 を返す。
    // spy で有効な rect を注入する。
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      left: 20,
      top: 30,
      width: 80,
      height: 40,
      right: 100,
      bottom: 70,
      x: 20,
      y: 30,
      toJSON: () => {},
    } as DOMRect);

    const dispose = startMouseAttentionProducer({
      attention,
      random: () => 0,
      timer,
      now: () => 0,
    });

    button.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, clientX: 60, clientY: 50 }),
    );

    const calls = attention.setSourceTarget.mock.calls.filter((c) => c[0] === "mouse");
    expect(calls).toHaveLength(1);
    expect(calls[0][1].rect).toMatchObject({ x: 20, y: 30, width: 80, height: 40 });

    button.remove();
    dispose.dispose();
  });
});

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionRuntime } from "../attention-runtime/types";
import { startDevAttentionProducer } from "./dev";

// subscribe コールバックを保持し、テストから手動で呼び出せる fake
function makeFakeAttention() {
  const setSourceTarget = vi.fn();
  const get = vi.fn(() => ({ target: null }));
  let subscribeCb: ((snapshot: { target: unknown }) => void) | null = null;
  const subscribeDispose = vi.fn();
  const subscribe = vi.fn((cb: (snapshot: { target: unknown }) => void) => {
    subscribeCb = cb;
    return { dispose: subscribeDispose };
  });
  const fake = {
    setSourceTarget,
    get,
    subscribe,
    /** テストから snapshot を手動 push する */
    push(snapshot: { target: unknown }) {
      subscribeCb?.(snapshot);
    },
    subscribeDispose,
  };
  return fake as unknown as AttentionRuntime & typeof fake;
}

describe("startDevAttentionProducer", () => {
  // ── 既存: smoke-test keydown ─────────────────────────────────────────────

  it("emits attention-debug target on Ctrl+Shift+A keydown", () => {
    const attention = makeFakeAttention();
    const dispose = startDevAttentionProducer({
      attention,
      isDev: true,
    });

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "A", ctrlKey: true, shiftKey: true, bubbles: true }),
    );

    const call = attention.setSourceTarget.mock.calls.find((c) => c[0] === "attention-debug");
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({
      source: "attention-debug",
      priority: 100,
    });
    dispose.dispose();
  });

  it("does nothing when isDev is false", () => {
    const attention = makeFakeAttention();
    const dispose = startDevAttentionProducer({
      attention,
      isDev: false,
    });

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "A", ctrlKey: true, shiftKey: true, bubbles: true }),
    );

    expect(attention.setSourceTarget).not.toHaveBeenCalled();
    dispose.dispose();
  });

  it("dispose removes the keydown listener (no further emits)", () => {
    const attention = makeFakeAttention();
    const handle = startDevAttentionProducer({
      attention,
      isDev: true,
    });
    handle.dispose();

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "A", ctrlKey: true, shiftKey: true, bubbles: true }),
    );

    expect(attention.setSourceTarget).not.toHaveBeenCalled();
  });

  // ── 新規: subscribe → console.info ──────────────────────────────────────

  describe("dev mode: console log on attention change", () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it("最初の non-null target で [attention] active を log する", () => {
      const attention = makeFakeAttention();
      const handle = startDevAttentionProducer({ attention, isDev: true });

      attention.push({
        target: {
          source: "typing",
          kind: "terminal-region",
          reason: "typing",
          priority: 0.7,
          confidence: 0.9,
          rect: { x: 0, y: 0, width: 100, height: 20 },
          timestamp: 0,
        },
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        "[attention] active",
        expect.objectContaining({ source: "typing", kind: "terminal-region" }),
      );
      handle.dispose();
    });

    it("同一 target が連続して来た場合は dedup して 1 回だけ log する", () => {
      const attention = makeFakeAttention();
      const handle = startDevAttentionProducer({ attention, isDev: true });

      const snapshot = {
        target: {
          source: "sent",
          kind: "terminal-region",
          reason: "none",
          priority: 0.5,
          confidence: 1,
          rect: { x: 0, y: 0, width: 80, height: 24 },
          timestamp: 0,
        },
      };

      attention.push(snapshot);
      attention.push(snapshot); // 同一 → dedup

      // "[attention] active" が 1 回だけ呼ばれること
      const activeCalls = consoleSpy.mock.calls.filter(
        (c: unknown[]) => c[0] === "[attention] active",
      );
      expect(activeCalls).toHaveLength(1);
      handle.dispose();
    });

    it("target が null になると [attention] cleared を log し、dedup が効く", () => {
      const attention = makeFakeAttention();
      const handle = startDevAttentionProducer({ attention, isDev: true });

      // まず active にしてから null へ
      attention.push({
        target: {
          source: "sent",
          kind: "terminal-region",
          reason: "sent",
          priority: 0.5,
          confidence: 1,
          rect: { x: 0, y: 0, width: 80, height: 24 },
          timestamp: 0,
        },
      });
      attention.push({ target: null });
      attention.push({ target: null }); // dedup: cleared は 1 回だけ

      const clearedCalls = consoleSpy.mock.calls.filter(
        (c: unknown[]) => c[0] === "[attention] cleared",
      );
      expect(clearedCalls).toHaveLength(1);
      handle.dispose();
    });

    it("dispose で subscribe が解除される", () => {
      const attention = makeFakeAttention();
      const handle = startDevAttentionProducer({ attention, isDev: true });

      handle.dispose();

      expect(attention.subscribeDispose).toHaveBeenCalledOnce();
    });
  });

  // ── 新規: production guard ───────────────────────────────────────────────

  describe("production (isDev: false): console.log も subscribe も呼ばれない", () => {
    it("console.info が一切呼ばれない", () => {
      const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      const attention = makeFakeAttention();
      const handle = startDevAttentionProducer({ attention, isDev: false });

      // production では subscribe 自体していないので push しても何も起きない
      expect(consoleSpy).not.toHaveBeenCalled();
      expect(attention.subscribe).not.toHaveBeenCalled();

      handle.dispose();
      consoleSpy.mockRestore();
    });
  });
});

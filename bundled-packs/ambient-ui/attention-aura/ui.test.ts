// @vitest-environment jsdom
import type {
  AmbientUiContext,
  AttentionAPI,
  AttentionSnapshot,
  AttentionTarget,
  Disposable,
} from "@yorishiro/sdk";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Aura, FADE_OUT_DURATION_S } from "./ui";

interface FakeAttention {
  current: AttentionSnapshot;
  publish(snapshot: AttentionSnapshot): void;
  api: AttentionAPI;
}

function makeFakeAttention(initial: AttentionSnapshot = { target: null }): FakeAttention {
  let current = initial;
  const listeners = new Set<(s: AttentionSnapshot) => void>();
  const api: AttentionAPI = {
    get: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(current);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      } satisfies Disposable;
    },
  };
  return {
    get current() {
      return current;
    },
    publish(snapshot) {
      current = snapshot;
      for (const l of Array.from(listeners)) l(snapshot);
    },
    api,
  };
}

const sampleTarget: AttentionTarget = {
  kind: "mouse",
  source: "mouse",
  rect: { x: 50, y: 60, width: 30, height: 30 },
  confidence: 1,
  priority: 4,
  timestamp: 0,
};

describe("Aura component", () => {
  let container: HTMLDivElement | null = null;
  let root: ReactDOM.Root | null = null;

  afterEach(() => {
    const r = root;
    if (r) {
      act(() => {
        r.unmount();
      });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  });

  it("renders nothing initially when target is null and opacity is 0", () => {
    const fake = makeFakeAttention();
    const ctx = { attention: fake.api } satisfies AmbientUiContext;

    container = document.createElement("div");
    document.body.appendChild(container);
    const r = ReactDOM.createRoot(container);
    root = r;
    act(() => {
      r.render(React.createElement(Aura, { ctx }));
    });

    const overlay = container.querySelector('[data-testid="attention-aura-overlay"]');
    expect(overlay).toBeNull();
  });

  it("target が null の初期状態では rAF を開始しない", () => {
    const rafSpy = vi.spyOn(window, "requestAnimationFrame");
    try {
      const fake = makeFakeAttention();
      const ctx = { attention: fake.api } satisfies AmbientUiContext;

      container = document.createElement("div");
      document.body.appendChild(container);
      const r = ReactDOM.createRoot(container);
      root = r;
      act(() => {
        r.render(React.createElement(Aura, { ctx }));
      });

      expect(rafSpy).not.toHaveBeenCalled();
    } finally {
      rafSpy.mockRestore();
    }
  });

  it("renders overlay div when target snapshot is published", async () => {
    const fake = makeFakeAttention();
    const ctx = { attention: fake.api } satisfies AmbientUiContext;

    container = document.createElement("div");
    document.body.appendChild(container);
    const r = ReactDOM.createRoot(container);
    root = r;
    act(() => {
      r.render(React.createElement(Aura, { ctx }));
    });

    act(() => {
      fake.publish({ target: sampleTarget });
    });

    // RAF を 1 tick 進める (jsdom では requestAnimationFrame は同期で setTimeout に
    // fall back する Polyfill がある場合と無い場合がある。act() で wrap して
    // pending React state を flush してから assert する)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const overlay = container.querySelector('[data-testid="attention-aura-overlay"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.getAttribute("aria-hidden")).toBe("true");
  });

  it("dispose unmounts the React root cleanly", () => {
    const fake = makeFakeAttention({ target: sampleTarget });
    const ctx = { attention: fake.api } satisfies AmbientUiContext;

    container = document.createElement("div");
    document.body.appendChild(container);
    const r = ReactDOM.createRoot(container);
    root = r;
    act(() => {
      r.render(React.createElement(Aura, { ctx }));
    });

    act(() => {
      r.unmount();
    });
    root = null;

    expect(container.children.length).toBe(0);
  });

  it("fade-out: target→null 後に opacity が複数フレームかけて滑らかに減衰し、duration 経過後に 0 になる", async () => {
    // fade-out が初フレームで RAF を止めて opacity を 0 にスナップする regression を防ぐ。
    // requestAnimationFrame を fake タイマーで制御し、フレームごとの opacity を記録する。
    vi.useFakeTimers();

    const frameCallbacks: FrameRequestCallback[] = [];
    let nextFrameId = 1;
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frameCallbacks.push(cb);
      return nextFrameId++;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const fake = makeFakeAttention({ target: sampleTarget });
    const ctx = { attention: fake.api } satisfies AmbientUiContext;

    container = document.createElement("div");
    document.body.appendChild(container);
    const r = ReactDOM.createRoot(container);
    root = r;

    await act(async () => {
      r.render(React.createElement(Aura, { ctx }));
    });

    // target を publish → RAF 起動
    await act(async () => {
      fake.publish({ target: sampleTarget });
    });

    // 数フレーム進めて target 収束を待つ (16ms × 30 = 480ms)
    for (let i = 0; i < 30; i++) {
      const cbs = frameCallbacks.splice(0);
      if (cbs.length === 0) break;
      const now = performance.now() + 16;
      await act(async () => {
        for (const cb of cbs) cb(now);
      });
    }

    // target を null に切り替え → fade-out 開始
    await act(async () => {
      fake.publish({ target: null });
    });

    // フレームごとの overlay opacity を収集する。1フレーム目 (≒16ms) の opacity は
    // まだ非ゼロのはずで、FADE_OUT_DURATION_S 経過後に 0 になることを確認する
    const opacities: number[] = [];

    // FADE_OUT_DURATION_S の 1.5 倍程度の時間をフレームで進める
    const totalFrames = Math.ceil((FADE_OUT_DURATION_S * 1.5 * 1000) / 16);
    for (let i = 0; i < totalFrames; i++) {
      const cbs = frameCallbacks.splice(0);
      if (cbs.length === 0) break;
      const now = performance.now() + 16 * (i + 1);
      await act(async () => {
        for (const cb of cbs) cb(now);
      });
      // overlay の現在 opacity を記録
      const overlay = container?.querySelector<HTMLElement>(
        '[data-testid="attention-aura-overlay"]',
      );
      const op = overlay ? Number.parseFloat(overlay.style.opacity ?? "0") : 0;
      opacities.push(op);
    }

    // 少なくとも複数フレームにわたって opacity が非ゼロの区間が存在する (≥5 フレーム)
    const nonZeroFrames = opacities.filter((op) => op > 0.001);
    expect(nonZeroFrames.length).toBeGreaterThanOrEqual(5);

    // fade 開始直後 (index 0 または 1 付近) は初期 opacity のほぼ 100% 近くを保つ
    if (opacities.length > 0 && opacities[0] !== undefined) {
      expect(opacities[0]).toBeGreaterThan(0.01);
    }

    // 全フレーム後の最終値は 0 (overlay が消えるか opacity===0 になっている)
    const lastOpacity = opacities[opacities.length - 1] ?? 0;
    expect(lastOpacity).toBe(0);

    rafSpy.mockRestore();
    vi.useRealTimers();
  });
});

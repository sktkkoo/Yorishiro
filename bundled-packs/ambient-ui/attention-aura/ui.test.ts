// @vitest-environment jsdom
import type {
  AmbientUiContext,
  AttentionAPI,
  AttentionSnapshot,
  AttentionTarget,
  Disposable,
} from "@charminal/sdk";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Aura } from "./ui";

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
    // fall back する Polyfill がある場合と無い場合がある。ここでは subscribe 直後の
    // setView が反映された state を確認するだけで sufficient)
    await new Promise((resolve) => setTimeout(resolve, 50));

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
});

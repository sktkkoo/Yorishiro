// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { AttentionRuntime } from "../attention-runtime/types";
import { startDevAttentionProducer } from "./dev";

function makeFakeAttention() {
  const setSourceTarget = vi.fn();
  const get = vi.fn(() => ({ target: null }));
  const subscribe = vi.fn(() => ({ dispose: () => {} }));
  const fake = { setSourceTarget, get, subscribe };
  return fake as unknown as AttentionRuntime & typeof fake;
}

describe("startDevAttentionProducer", () => {
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
});

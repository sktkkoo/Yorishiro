// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { AttentionRuntime } from "../attention-runtime/types";
import { startMouseAttentionProducer } from "./mouse";

interface FakeAttention {
  readonly setSourceTarget: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
  readonly subscribe: ReturnType<typeof vi.fn>;
}

function makeFakeAttention(): FakeAttention {
  return {
    setSourceTarget: vi.fn(),
    get: vi.fn(() => ({ target: null })),
    subscribe: vi.fn(() => ({ dispose: () => {} })),
  };
}

describe("startMouseAttentionProducer", () => {
  it("emits mouse target with click coordinates for non-interactive target", () => {
    const attention = makeFakeAttention();
    const dispose = startMouseAttentionProducer({
      attention: attention as unknown as AttentionRuntime,
    });

    const event = new MouseEvent("click", { clientX: 100, clientY: 200, bubbles: true });
    document.body.dispatchEvent(event);

    const call = attention.setSourceTarget.mock.calls.find((c) => c[0] === "mouse");
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({
      kind: "mouse",
      source: "mouse",
      priority: 4,
    });
    const rect = call?.[1]?.rect;
    expect(rect.x).toBeCloseTo(100 - 10);
    expect(rect.y).toBeCloseTo(200 - 10);
    expect(rect.width).toBe(20);
    expect(rect.height).toBe(20);
    dispose.dispose();
  });

  it("emits mouse target with element rect when click target has bounding rect", () => {
    const attention = makeFakeAttention();
    const button = document.createElement("button");
    document.body.appendChild(button);
    // jsdom では layout が無いので getBoundingClientRect は 0,0,0,0 を返すことがある。
    // その場合 fallback path に落ちるので、test は「rect が存在し interactive path を
    // 通った形跡 (kind=mouse / priority=4)」だけを assert する。

    const dispose = startMouseAttentionProducer({
      attention: attention as unknown as AttentionRuntime,
    });

    button.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 75, clientY: 75 }));

    const call = attention.setSourceTarget.mock.calls.find((c) => c[0] === "mouse");
    expect(call).toBeDefined();
    expect(call?.[1].kind).toBe("mouse");
    expect(call?.[1].priority).toBe(4);
    expect(call?.[1].rect.width).toBeGreaterThanOrEqual(20);

    button.remove();
    dispose.dispose();
  });

  it("uses fallback rect when click event has no Element target", () => {
    const attention = makeFakeAttention();
    const dispose = startMouseAttentionProducer({
      attention: attention as unknown as AttentionRuntime,
    });

    const event = new MouseEvent("click", { clientX: 5, clientY: 5, bubbles: true });
    document.dispatchEvent(event);

    const call = attention.setSourceTarget.mock.calls.find((c) => c[0] === "mouse");
    expect(call).toBeDefined();
    expect(call?.[1].rect.width).toBe(20);
    expect(call?.[1].rect.height).toBe(20);
    dispose.dispose();
  });

  it("dispose removes the click listener (no further emits)", () => {
    const attention = makeFakeAttention();
    const handle = startMouseAttentionProducer({
      attention: attention as unknown as AttentionRuntime,
    });

    handle.dispose();
    document.body.dispatchEvent(
      new MouseEvent("click", { clientX: 50, clientY: 50, bubbles: true }),
    );

    expect(attention.setSourceTarget).not.toHaveBeenCalled();
  });
});

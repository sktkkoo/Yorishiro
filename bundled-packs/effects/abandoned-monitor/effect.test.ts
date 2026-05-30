// @vitest-environment jsdom

import type { Disposable, EffectContext } from "@charminal/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import abandonedMonitor, { DEFAULT_LINES, DEFAULTS, GLITCH_CHARS } from "./effect";

interface TestCtx {
  readonly ctx: EffectContext<Record<string, unknown>>;
  readonly controller: AbortController;
  readonly addDomLayer: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly after: ReturnType<typeof vi.fn>;
  readonly container: HTMLDivElement;
}

function makeCtx(overrides: { after?: () => Promise<void> } = {}): TestCtx {
  const controller = new AbortController();
  const dispose = vi.fn();
  const layer: Disposable = { dispose };
  const container = document.createElement("div");
  const addDomLayer = vi.fn((setup: (c: HTMLDivElement) => void): Disposable => {
    setup(container);
    return layer;
  });
  const after = vi.fn(overrides.after ?? (() => Promise.resolve()));
  const ctx = {
    options: {},
    time: { after },
    signal: controller.signal,
    renderer: {
      addDomLayer,
      addShakeFilter: vi.fn(),
      addCssFilter: vi.fn(),
      addParticles: vi.fn(),
      drawOnCanvas: vi.fn(),
      queryTerminalCells: vi.fn(() => null),
    },
    audio: { play: vi.fn(async () => {}) },
  } as unknown as EffectContext<Record<string, unknown>>;
  return { ctx, controller, addDomLayer, dispose, after, container };
}

function getTextBlock(container: HTMLDivElement): HTMLDivElement {
  const textBlock = container.children[2] as HTMLDivElement | undefined;
  if (!(textBlock instanceof HTMLDivElement)) throw new Error("textBlock が見つからない");
  return textBlock;
}

function getBackground(container: HTMLDivElement): HTMLDivElement {
  const background = container.children[0] as HTMLDivElement | undefined;
  if (!(background instanceof HTMLDivElement)) throw new Error("background が見つからない");
  return background;
}

describe("abandoned-monitor effect", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("EffectDefinition の shape を満たす", () => {
    expect(abandonedMonitor.id).toBe("abandoned-monitor");
    expect(abandonedMonitor.type).toBe("effect");
    expect(abandonedMonitor.singleton).toBe(true);
  });

  it("addDomLayer を 1 回だけ呼ぶ", async () => {
    const { ctx, addDomLayer } = makeCtx();

    await abandonedMonitor.run(ctx, {});

    expect(addDomLayer).toHaveBeenCalledOnce();
  });

  it("options.lines 指定時、その行を overlay に描画する", async () => {
    const { ctx, container } = makeCtx();

    await abandonedMonitor.run(ctx, { lines: ["ALPHA", "BETA"] });

    expect(container.textContent).toContain("ALPHA");
    expect(container.textContent).toContain("BETA");
  });

  it("lines 未指定時は DEFAULT_LINES を描画する", async () => {
    const { ctx, container } = makeCtx();

    await abandonedMonitor.run(ctx, {});

    expect(container.textContent).toContain(DEFAULT_LINES[1]);
  });

  it("移植元と同じ既定値を保持して適用する", async () => {
    const { ctx, after, container } = makeCtx();

    await abandonedMonitor.run(ctx, {});

    expect(DEFAULTS.durationMs).toBe(12000);
    expect(DEFAULTS.color).toBe("#00ff41");
    expect(DEFAULTS.bgColor).toBe("rgba(0, 0, 0, 0.85)");
    expect(DEFAULTS.typeSpeed).toBe(35);
    expect(DEFAULTS.glitchIntensity).toBe(1);
    expect(DEFAULTS.fontSize).toBe(16);
    expect(after).toHaveBeenCalledWith(DEFAULTS.durationMs);
    expect(getTextBlock(container).style.fontSize).toBe(`${DEFAULTS.fontSize}px`);
    expect(getBackground(container).style.backgroundColor).toBe(DEFAULTS.bgColor);
  });

  it("代表 option の上書きを反映する", async () => {
    const { ctx, after, container } = makeCtx();

    await abandonedMonitor.run(ctx, {
      durationMs: 3456,
      color: "rgb(1, 2, 3)",
      bgColor: "rgba(4, 5, 6, 0.7)",
      fontSize: 22,
    });

    expect(after).toHaveBeenCalledWith(3456);
    expect(getTextBlock(container).style.color).toBe("rgb(1, 2, 3)");
    expect(getTextBlock(container).style.fontSize).toBe("22px");
    expect(getBackground(container).style.backgroundColor).toBe("rgba(4, 5, 6, 0.7)");
  });

  it("GLITCH_CHARS に絵文字として表示される記号を含まない", () => {
    expect(GLITCH_CHARS).not.toContain("☠");
    expect(GLITCH_CHARS).not.toContain("⚠");
    expect(GLITCH_CHARS).not.toContain("⚡");
  });

  it("正常終了時に handle を dispose する", async () => {
    const { ctx, dispose } = makeCtx();

    await abandonedMonitor.run(ctx, {});

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("abort 時に RAF を止めて handle を dispose する", async () => {
    let resolveAfter: (() => void) | undefined;
    const { ctx, controller, dispose } = makeCtx({
      after: () =>
        new Promise<void>((resolve) => {
          resolveAfter = resolve;
        }),
    });

    const runPromise = abandonedMonitor.run(ctx, {});
    controller.abort();
    resolveAfter?.();
    await runPromise;

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});

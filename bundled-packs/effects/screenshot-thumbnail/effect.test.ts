// @vitest-environment jsdom

import type { Disposable, EffectContext } from "@yorishiro/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import screenshotThumbnail from "./effect";

function makeCtx(options: Partial<Record<string, unknown>> = {}): {
  ctx: EffectContext<Record<string, unknown>>;
  addDomLayer: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  container: HTMLDivElement;
  after: ReturnType<typeof vi.fn>;
} {
  const dispose = vi.fn();
  const layer: Disposable = { dispose };
  const container = document.createElement("div");
  Object.defineProperty(container, "getBoundingClientRect", {
    value: () => ({ width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600 }),
  });
  const addDomLayer = vi.fn((setup: (c: HTMLDivElement) => void): Disposable => {
    setup(container);
    return layer;
  });
  const after = vi.fn(() => Promise.resolve());
  const ctx = {
    options,
    time: { after },
    signal: { aborted: false } as unknown as AbortSignal,
    renderer: {
      addDomLayer,
      addShakeFilter: vi.fn(),
      addCssFilter: vi.fn(),
      addParticles: vi.fn(),
      drawOnCanvas: vi.fn(),
    },
    audio: { play: vi.fn(async () => {}) },
  } as unknown as EffectContext<Record<string, unknown>>;
  return { ctx, addDomLayer, dispose, container, after };
}

let restoreDefaultImageMock: (() => void) | null = null;

function installMockDecodedImage(dimensions: { readonly width: number; readonly height: number }): {
  readonly decode: ReturnType<typeof vi.fn>;
  readonly restore: () => void;
} {
  const naturalWidthDescriptor = Object.getOwnPropertyDescriptor(
    HTMLImageElement.prototype,
    "naturalWidth",
  );
  const naturalHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLImageElement.prototype,
    "naturalHeight",
  );
  const decodeDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "decode");
  const decode = vi.fn(() => Promise.resolve());

  Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
    configurable: true,
    get: () => dimensions.width,
  });
  Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", {
    configurable: true,
    get: () => dimensions.height,
  });
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    configurable: true,
    value: decode,
  });

  return {
    decode,
    restore: () => {
      if (naturalWidthDescriptor) {
        Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", naturalWidthDescriptor);
      }
      if (naturalHeightDescriptor) {
        Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", naturalHeightDescriptor);
      }
      if (decodeDescriptor) {
        Object.defineProperty(HTMLImageElement.prototype, "decode", decodeDescriptor);
      } else {
        delete (HTMLImageElement.prototype as unknown as Record<string, unknown>).decode;
      }
    },
  };
}

async function withMockDecodedImage(
  dimensions: { readonly width: number; readonly height: number },
  run: (decode: ReturnType<typeof vi.fn>) => Promise<void>,
): Promise<void> {
  const mock = installMockDecodedImage(dimensions);

  try {
    await run(mock.decode);
  } finally {
    mock.restore();
  }
}

beforeEach(() => {
  restoreDefaultImageMock = installMockDecodedImage({ width: 0, height: 0 }).restore;
});

afterEach(() => {
  restoreDefaultImageMock?.();
  restoreDefaultImageMock = null;
});

describe("screenshot-thumbnail effect", () => {
  it("is declared as an EffectDefinition with id 'screenshot-thumbnail'", () => {
    expect(screenshotThumbnail.id).toBe("screenshot-thumbnail");
    expect(screenshotThumbnail.type).toBe("effect");
  });

  it("adds a DOM layer with a full-screen image", async () => {
    const { ctx, addDomLayer, container } = makeCtx();
    await screenshotThumbnail.run(ctx, { dataUrl: "data:image/png;base64,AAAA" });
    expect(addDomLayer).toHaveBeenCalledOnce();
    const img = container.firstElementChild as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img?.tagName).toBe("IMG");
    expect(img?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(img?.style.position).toBe("absolute");
    expect(img?.style.left).toBe("0px");
    expect(img?.style.top).toBe("0px");
    expect(img?.style.width).toBe("800px");
    expect(img?.style.height).toBe("600px");
    expect(img?.style.pointerEvents).toBe("none");
  });

  it("disposes the DOM layer after the animation sequence", async () => {
    const { ctx, dispose } = makeCtx();
    await screenshotThumbnail.run(ctx, { dataUrl: "data:image/png;base64,AAAA" });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("waits for shrink, hold, and fade-out durations", async () => {
    const { ctx, after } = makeCtx();
    await screenshotThumbnail.run(ctx, {
      dataUrl: "data:image/png;base64,AAAA",
      shrinkMs: 120,
      holdMs: 900,
      fadeOutMs: 180,
    });
    expect(after).toHaveBeenCalledWith(120);
    expect(after).toHaveBeenCalledWith(900);
    expect(after).toHaveBeenCalledWith(180);
  });

  it("sizes decoded images with contain fit so the aspect ratio is preserved", async () => {
    await withMockDecodedImage({ width: 1000, height: 500 }, async (decode) => {
      const { ctx, container } = makeCtx();
      await screenshotThumbnail.run(ctx, {
        dataUrl: "data:image/png;base64,WIDE",
        thumbnailWidth: 200,
        margin: 20,
      });

      const img = container.firstElementChild as HTMLImageElement | null;
      expect(decode).toHaveBeenCalledOnce();
      expect(img?.style.left).toBe("0px");
      expect(img?.style.top).toBe("100px");
      expect(img?.style.width).toBe("800px");
      expect(img?.style.height).toBe("400px");
      expect(img?.style.objectFit).toBe("");
      expect(img?.style.transform).toBe("translate(580px, 380px) scale(0.25)");
    });
  });

  it("card decoration lengths are compensated by the final thumbnail scale", async () => {
    const { ctx, container } = makeCtx();
    await screenshotThumbnail.run(ctx, {
      dataUrl: "data:image/png;base64,AAAA",
      thumbnailWidth: 240,
      margin: 0,
    });

    const img = container.firstElementChild as HTMLImageElement | null;
    const scale = 240 / 800;
    const shadowLengths =
      img?.style.boxShadow.match(/\d+(?:\.\d+)?px/g)?.map((value) => Number.parseFloat(value)) ??
      [];

    expect(img?.style.transform).toBe("translate(560px, 420px) scale(0.3)");
    expect(Number.parseFloat(img?.style.borderRadius ?? "")).toBeCloseTo(10 / scale, 5);
    expect(Number.parseFloat(img?.style.borderWidth ?? "")).toBeCloseTo(1 / scale, 5);
    expect(shadowLengths[0]).toBeCloseTo(14 / scale, 5);
    expect(shadowLengths[1]).toBeCloseTo(34 / scale, 5);
  });

  it("does not create a layer without dataUrl", async () => {
    const { ctx, addDomLayer } = makeCtx();
    await screenshotThumbnail.run(ctx, {});
    expect(addDomLayer).not.toHaveBeenCalled();
  });

  it("replaces the currently displayed layer on consecutive captures", async () => {
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    const firstContainer = document.createElement("div");
    const secondContainer = document.createElement("div");
    for (const container of [firstContainer, secondContainer]) {
      Object.defineProperty(container, "getBoundingClientRect", {
        value: () => ({ width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600 }),
      });
    }
    const addDomLayer = vi
      .fn()
      .mockImplementationOnce((setup: (c: HTMLDivElement) => void): Disposable => {
        setup(firstContainer);
        return { dispose: firstDispose };
      })
      .mockImplementationOnce((setup: (c: HTMLDivElement) => void): Disposable => {
        setup(secondContainer);
        return { dispose: secondDispose };
      });
    const firstAfter = { resolve: null as (() => void) | null };
    let firstAfterPending = true;
    const after = vi.fn(() => {
      if (!firstAfterPending) return Promise.resolve();
      firstAfterPending = false;
      return new Promise<void>((resolve) => {
        firstAfter.resolve = resolve;
      });
    });
    const ctx = {
      options: {},
      time: { after },
      signal: { aborted: false } as unknown as AbortSignal,
      renderer: {
        addDomLayer,
        addShakeFilter: vi.fn(),
        addCssFilter: vi.fn(),
        addParticles: vi.fn(),
        drawOnCanvas: vi.fn(),
      },
      audio: { play: vi.fn(async () => {}) },
    } as unknown as EffectContext<Record<string, unknown>>;

    const firstRun = screenshotThumbnail.run(ctx, { dataUrl: "data:image/png;base64,FIRST" });
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const secondRun = screenshotThumbnail.run(ctx, { dataUrl: "data:image/png;base64,SECOND" });

    expect(firstDispose).toHaveBeenCalledOnce();
    expect(secondDispose).not.toHaveBeenCalled();
    expect(addDomLayer).toHaveBeenCalledTimes(2);

    await secondRun;
    firstAfter.resolve?.();
    await firstRun;
    expect(secondDispose).toHaveBeenCalledOnce();
  });

  it("still disposes the layer when time.after rejects", async () => {
    const { ctx, dispose } = makeCtx();
    (ctx.time.after as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));

    await expect(
      screenshotThumbnail.run(ctx, { dataUrl: "data:image/png;base64,AAAA" }),
    ).rejects.toThrow("boom");
    expect(dispose).toHaveBeenCalledOnce();
  });
});

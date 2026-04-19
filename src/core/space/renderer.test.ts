import { beforeEach, describe, expect, it, vi } from "vitest";
import { Renderer, type RendererDomFactories } from "./renderer";

// Minimal shake target — only the `.style.transform` string is written/read.
interface FakeTarget {
  style: { transform: string };
}

const makeTarget = (): FakeTarget => ({ style: { transform: "" } });

describe("Renderer.addShakeFilter", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "requestAnimationFrame",
      (_cb: FrameRequestCallback): number => 0, // never actually fire in tests
    );
  });

  it("returns a Disposable handle", () => {
    const target = makeTarget();
    const renderer = new Renderer({ shakeTarget: target as unknown as HTMLElement });
    const filter = renderer.addShakeFilter(0.5);
    expect(typeof filter.dispose).toBe("function");
  });

  it("clears the target's transform on dispose", () => {
    const target = makeTarget();
    target.style.transform = "translate(5px, 5px)";
    const renderer = new Renderer({ shakeTarget: target as unknown as HTMLElement });
    const filter = renderer.addShakeFilter(0.5);
    filter.dispose();
    expect(target.style.transform).toBe("");
  });

  it("stops animating after dispose (no new transform writes)", () => {
    const target = makeTarget();
    const frames: Array<() => void> = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
      frames.push(() => cb(0));
      return frames.length;
    });
    const renderer = new Renderer({ shakeTarget: target as unknown as HTMLElement });
    const filter = renderer.addShakeFilter(0.5);
    // First tick runs, sets transform to something
    frames.shift()?.();
    const afterFirstTick = target.style.transform;
    filter.dispose();
    // Drain any remaining queued frames — they should be no-ops after dispose
    while (frames.length > 0) frames.shift()?.();
    // Dispose sets transform back to "" and subsequent frames don't overwrite it
    expect(target.style.transform).toBe("");
    // Sanity check: the first tick had set a non-empty transform
    expect(afterFirstTick).not.toBe("");
  });
});

// drawOnCanvas は DOM 依存が大きいが、test 環境に jsdom を入れない方針の
// ため、RendererDomFactories で canvas / window を全部差し替える。
// fake canvas / fake mount element を以下で作る。

interface FakeCanvasLike {
  readonly style: Record<string, string>;
  width: number;
  height: number;
  readonly parentElements: FakeMountLike[]; // 現在どこに append されているか
  readonly getContext: ReturnType<typeof vi.fn>;
  readonly remove: ReturnType<typeof vi.fn>;
}

/** addDomLayer が生成する fake div。canvas と同じ remove / style を持つ。 */
interface FakeDivLike {
  readonly style: Record<string, string>;
  readonly parentElements: FakeMountLike[];
  readonly remove: ReturnType<typeof vi.fn>;
}

interface FakeMountLike {
  readonly children: Array<FakeCanvasLike | FakeDivLike>;
  readonly appendChild: ReturnType<typeof vi.fn>;
}

const makeFakeContext = (): CanvasRenderingContext2D =>
  ({ scale: vi.fn() }) as unknown as CanvasRenderingContext2D;

const makeFakeCanvas = (ctx: CanvasRenderingContext2D | null): FakeCanvasLike => {
  const canvas: FakeCanvasLike = {
    style: {},
    width: 0,
    height: 0,
    parentElements: [],
    getContext: vi.fn().mockReturnValue(ctx),
    remove: vi.fn(function remove(this: unknown): void {
      const c = canvas;
      // 最後に append された parent から自分を外す（1 回しか発生しない想定）。
      const parent = c.parentElements.pop();
      if (parent) {
        const idx = parent.children.indexOf(c);
        if (idx >= 0) parent.children.splice(idx, 1);
      }
    }),
  };
  return canvas;
};

const makeFakeDiv = (): FakeDivLike => {
  const div: FakeDivLike = {
    style: {},
    parentElements: [],
    remove: vi.fn(function remove(this: unknown): void {
      const d = div;
      const parent = d.parentElements.pop();
      if (parent) {
        const idx = parent.children.indexOf(d);
        if (idx >= 0) parent.children.splice(idx, 1);
      }
    }),
  };
  return div;
};

const makeFakeMount = (): FakeMountLike => {
  const mount: FakeMountLike = {
    children: [],
    appendChild: vi.fn((child: FakeCanvasLike | FakeDivLike) => {
      mount.children.push(child);
      child.parentElements.push(mount);
      return child;
    }),
  };
  return mount;
};

interface DomHarness {
  readonly dom: RendererDomFactories;
  readonly canvases: FakeCanvasLike[];
  readonly divs: FakeDivLike[];
  ctx: CanvasRenderingContext2D | null;
  dpr: number;
  width: number;
  height: number;
}

const makeDomHarness = (overrides?: {
  ctx?: CanvasRenderingContext2D | null;
  dpr?: number;
  width?: number;
  height?: number;
  defaultCanvasMount?: HTMLElement;
}): DomHarness => {
  const harness: DomHarness = {
    canvases: [],
    divs: [],
    ctx: overrides?.ctx === undefined ? makeFakeContext() : overrides.ctx,
    dpr: overrides?.dpr ?? 1,
    width: overrides?.width ?? 1024,
    height: overrides?.height ?? 768,
    dom: {
      createCanvas: () => {
        const canvas = makeFakeCanvas(harness.ctx);
        harness.canvases.push(canvas);
        return canvas as unknown as HTMLCanvasElement;
      },
      createDiv: () => {
        const div = makeFakeDiv();
        harness.divs.push(div);
        return div as unknown as HTMLDivElement;
      },
      getWindowWidth: () => harness.width,
      getWindowHeight: () => harness.height,
      getDevicePixelRatio: () => harness.dpr,
      getDefaultCanvasMount: () =>
        overrides?.defaultCanvasMount ?? (makeFakeMount() as unknown as HTMLElement),
    },
  };
  return harness;
};

describe("Renderer.drawOnCanvas", () => {
  const makeRenderer = (harness: DomHarness, canvasMount?: HTMLElement): Renderer =>
    new Renderer({
      shakeTarget: { style: { transform: "" } } as unknown as HTMLElement,
      canvasMount,
      dom: harness.dom,
    });

  it("returns a Disposable handle", () => {
    const harness = makeDomHarness();
    const mount = makeFakeMount();
    const renderer = makeRenderer(harness, mount as unknown as HTMLElement);
    const handle = renderer.drawOnCanvas(() => {});
    expect(typeof handle.dispose).toBe("function");
    handle.dispose();
  });

  it("canvasMount に渡した element に canvas を append する", () => {
    const harness = makeDomHarness();
    const mount = makeFakeMount();
    const renderer = makeRenderer(harness, mount as unknown as HTMLElement);
    const handle = renderer.drawOnCanvas(() => {});
    expect(mount.appendChild).toHaveBeenCalledTimes(1);
    expect(mount.children.length).toBe(1);
    expect(mount.children[0]).toBe(harness.canvases[0]);
    handle.dispose();
  });

  it("canvasMount を省略すると dom.getDefaultCanvasMount() の返り値が使われる", () => {
    // resolveCanvasMount は factory の getDefaultCanvasMount を通すので、
    // harness で fake mount を返すようにして直接観測する。
    const fakeDefaultMount = makeFakeMount();
    const harness = makeDomHarness({
      defaultCanvasMount: fakeDefaultMount as unknown as HTMLElement,
    });
    const renderer = makeRenderer(harness); // canvasMount 省略
    const handle = renderer.drawOnCanvas(() => {});
    expect(fakeDefaultMount.appendChild).toHaveBeenCalledTimes(1);
    expect(fakeDefaultMount.children.length).toBe(1);
    handle.dispose();
  });

  it("getContext('2d') の結果を draw callback にそのまま渡す", () => {
    const ctx = makeFakeContext();
    const harness = makeDomHarness({ ctx });
    const mount = makeFakeMount();
    const renderer = makeRenderer(harness, mount as unknown as HTMLElement);
    const draw = vi.fn();
    const handle = renderer.drawOnCanvas(draw);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(draw).toHaveBeenCalledWith(ctx);
    handle.dispose();
  });

  it("draw callback は 1 回だけ呼ばれる（毎フレームは呼ばない）", () => {
    const harness = makeDomHarness();
    const mount = makeFakeMount();
    const renderer = makeRenderer(harness, mount as unknown as HTMLElement);
    const draw = vi.fn();
    const handle = renderer.drawOnCanvas(draw);
    expect(draw).toHaveBeenCalledTimes(1);
    // 時間が進んでも call 回数は増えない（同期 1 回のみの契約）。
    handle.dispose();
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it("getContext が null を返す場合は throw せず Disposable を返す", () => {
    const harness = makeDomHarness({ ctx: null });
    const mount = makeFakeMount();
    const renderer = makeRenderer(harness, mount as unknown as HTMLElement);
    const draw = vi.fn();
    let handle: { dispose: () => void } | undefined;
    expect(() => {
      handle = renderer.drawOnCanvas(draw);
    }).not.toThrow();
    expect(handle).toBeDefined();
    expect(typeof handle?.dispose).toBe("function");
    // ctx が取れない以上 draw callback は呼ばない（無効な ctx を渡さない）。
    expect(draw).not.toHaveBeenCalled();
    // dispose 呼んでも例外なし。
    expect(() => handle?.dispose()).not.toThrow();
  });

  it("dispose で canvas が parent から remove される", () => {
    const harness = makeDomHarness();
    const mount = makeFakeMount();
    const renderer = makeRenderer(harness, mount as unknown as HTMLElement);
    const handle = renderer.drawOnCanvas(() => {});
    const canvas = harness.canvases[0];
    expect(mount.children).toContain(canvas);
    handle.dispose();
    expect(canvas?.remove).toHaveBeenCalledTimes(1);
    expect(mount.children).not.toContain(canvas);
  });

  it("dispose は冪等：2 回呼んでも例外なし、canvas.remove は 1 回だけ発生する", () => {
    const harness = makeDomHarness();
    const mount = makeFakeMount();
    const renderer = makeRenderer(harness, mount as unknown as HTMLElement);
    const handle = renderer.drawOnCanvas(() => {});
    const canvas = harness.canvases[0];
    expect(() => {
      handle.dispose();
      handle.dispose();
    }).not.toThrow();
    expect(canvas?.remove).toHaveBeenCalledTimes(1);
  });

  it("HiDPI を考慮した canvas.width / height を設定し ctx.scale(dpr, dpr) を呼ぶ", () => {
    const ctx = makeFakeContext();
    const harness = makeDomHarness({ ctx, dpr: 2, width: 800, height: 600 });
    const mount = makeFakeMount();
    const renderer = makeRenderer(harness, mount as unknown as HTMLElement);
    const handle = renderer.drawOnCanvas(() => {});
    const canvas = harness.canvases[0];
    expect(canvas?.width).toBe(1600); // 800 * 2
    expect(canvas?.height).toBe(1200); // 600 * 2
    expect(ctx.scale).toHaveBeenCalledWith(2, 2);
    handle.dispose();
  });

  it("overlay の fixed style（position / inset / pointer-events / z-index）が canvas に適用される", () => {
    const harness = makeDomHarness();
    const mount = makeFakeMount();
    const renderer = makeRenderer(harness, mount as unknown as HTMLElement);
    const handle = renderer.drawOnCanvas(() => {});
    const canvas = harness.canvases[0];
    expect(canvas?.style.position).toBe("fixed");
    expect(canvas?.style.inset).toBe("0");
    expect(canvas?.style.width).toBe("100vw");
    expect(canvas?.style.height).toBe("100vh");
    expect(canvas?.style.pointerEvents).toBe("none");
    expect(canvas?.style.zIndex).toBe("9999");
    handle.dispose();
  });
});

// ─── addDomLayer ──────────────────────────────────────────

describe("Renderer.addDomLayer", () => {
  const makeRenderer = (harness: DomHarness, canvasMount?: HTMLElement): Renderer =>
    new Renderer({
      shakeTarget: { style: { transform: "" } } as unknown as HTMLElement,
      canvasMount,
      dom: harness.dom,
    });

  it("canvasMount に渡した element に div を append する", () => {
    const harness = makeDomHarness();
    const mount = makeFakeMount();
    const renderer = makeRenderer(harness, mount as unknown as HTMLElement);
    const handle = renderer.addDomLayer(() => {});
    expect(mount.appendChild).toHaveBeenCalledTimes(1);
    expect(mount.children.length).toBe(1);
    expect(mount.children[0]).toBe(harness.divs[0]);
    handle.dispose();
  });

  it("setup callback が 1 回だけ呼ばれる", () => {
    const harness = makeDomHarness();
    const mount = makeFakeMount();
    const renderer = makeRenderer(harness, mount as unknown as HTMLElement);
    const setup = vi.fn();
    const handle = renderer.addDomLayer(setup);
    expect(setup).toHaveBeenCalledTimes(1);
    // setup に渡されるのは生成された div
    expect(setup).toHaveBeenCalledWith(harness.divs[0]);
    handle.dispose();
  });

  it("dispose で div が parent から remove される", () => {
    const harness = makeDomHarness();
    const mount = makeFakeMount();
    const renderer = makeRenderer(harness, mount as unknown as HTMLElement);
    const handle = renderer.addDomLayer(() => {});
    const div = harness.divs[0];
    expect(mount.children).toContain(div);
    handle.dispose();
    expect(div?.remove).toHaveBeenCalledTimes(1);
    expect(mount.children).not.toContain(div);
  });

  it("dispose は冪等：2 回呼んでも例外なし、div.remove は 1 回だけ発生する", () => {
    const harness = makeDomHarness();
    const mount = makeFakeMount();
    const renderer = makeRenderer(harness, mount as unknown as HTMLElement);
    const handle = renderer.addDomLayer(() => {});
    const div = harness.divs[0];
    expect(() => {
      handle.dispose();
      handle.dispose();
    }).not.toThrow();
    expect(div?.remove).toHaveBeenCalledTimes(1);
  });

  it("overlay の fixed style（position / inset / pointer-events / z-index）が div に適用される", () => {
    const harness = makeDomHarness();
    const mount = makeFakeMount();
    const renderer = makeRenderer(harness, mount as unknown as HTMLElement);
    const handle = renderer.addDomLayer(() => {});
    const div = harness.divs[0];
    expect(div?.style.position).toBe("fixed");
    expect(div?.style.inset).toBe("0");
    expect(div?.style.pointerEvents).toBe("none");
    expect(div?.style.zIndex).toBe("9999");
    handle.dispose();
  });

  it("canvasMount を省略すると dom.getDefaultCanvasMount() の返り値が使われる", () => {
    const fakeDefaultMount = makeFakeMount();
    const harness = makeDomHarness({
      defaultCanvasMount: fakeDefaultMount as unknown as HTMLElement,
    });
    const renderer = makeRenderer(harness); // canvasMount 省略
    const handle = renderer.addDomLayer(() => {});
    expect(fakeDefaultMount.appendChild).toHaveBeenCalledTimes(1);
    expect(fakeDefaultMount.children.length).toBe(1);
    handle.dispose();
  });
});

// ─── queryTerminalCells ───────────────────────────────────

describe("Renderer.queryTerminalCells", () => {
  it("terminalCellExtractor が設定されている場合、その返り値を委譲する", () => {
    const cellData = {
      cells: [{ char: "A", x: 0, y: 0, row: 0, col: 0, fgColor: "#fff" }],
      cellWidth: 8,
      cellHeight: 16,
      terminalRect: { left: 0, top: 0, width: 800, height: 600 },
      cols: 80,
      rows: 24,
    };
    const extractor = vi.fn(() => cellData);
    const renderer = new Renderer({
      shakeTarget: { style: { transform: "" } } as unknown as HTMLElement,
      terminalCellExtractor: extractor,
    });
    const result = renderer.queryTerminalCells();
    expect(extractor).toHaveBeenCalledTimes(1);
    expect(result).toBe(cellData);
  });

  it("terminalCellExtractor が未設定の場合、null を返す", () => {
    const renderer = new Renderer({
      shakeTarget: { style: { transform: "" } } as unknown as HTMLElement,
    });
    const result = renderer.queryTerminalCells();
    expect(result).toBeNull();
  });

  it("terminalCellExtractor が null を返した場合、null を返す", () => {
    const extractor = vi.fn(() => null);
    const renderer = new Renderer({
      shakeTarget: { style: { transform: "" } } as unknown as HTMLElement,
      terminalCellExtractor: extractor,
    });
    const result = renderer.queryTerminalCells();
    expect(result).toBeNull();
  });
});

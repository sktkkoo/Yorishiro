import type { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexThemeDecorations, codexSurfaceColor } from "./codex-theme-decorations";

function setup() {
  const callbacks = new Map<string, () => void>();
  let frame: (() => void) | undefined;
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frame = undefined;
  });
  const cells: { color: number; inverse?: boolean; indexed?: boolean }[][] = [];
  const buffer = {
    viewportY: 0,
    baseY: 0,
    cursorY: 1,
    length: 100,
    getLine: vi.fn((y: number) => ({
      getCell: (x: number) => {
        const cell = cells[y]?.[x];
        return cell
          ? {
              getBgColor: () => cell.color,
              isBgRGB: () => !cell.indexed,
              isInverse: () => (cell.inverse ? 1 : 0),
            }
          : undefined;
      },
    })),
  };
  const subscriptionDisposals: ReturnType<typeof vi.fn>[] = [];
  const on = (name: string) => (callback: () => void) => {
    callbacks.set(name, callback);
    const dispose = vi.fn();
    subscriptionDisposals.push(dispose);
    return { dispose };
  };
  const markers: { line: number; isDisposed: boolean; dispose: () => void }[] = [];
  const decorations: { dispose: ReturnType<typeof vi.fn> }[] = [];
  const term = {
    cols: 4,
    rows: 2,
    buffer: { active: buffer, onBufferChange: on("buffer") },
    onWriteParsed: on("write"),
    onScroll: on("scroll"),
    onResize: on("resize"),
    registerMarker: vi.fn((offset: number) => {
      const marker = {
        line: buffer.baseY + buffer.cursorY + offset,
        isDisposed: false,
        dispose() {
          this.isDisposed = true;
        },
      };
      markers.push(marker);
      return marker;
    }),
    registerDecoration: vi.fn(() => {
      const decoration = { dispose: vi.fn() };
      decorations.push(decoration);
      return decoration;
    }),
  };
  const adapter = new CodexThemeDecorations(term as unknown as Terminal);
  const stale = 0x303134;
  const flush = () => {
    const callback = frame;
    frame = undefined;
    callback?.();
  };
  return {
    adapter,
    term,
    cells,
    stale,
    buffer,
    markers,
    decorations,
    subscriptionDisposals,
    flush,
    fire: (name: string) => callbacks.get(name)?.(),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Codex cached surface adaptation", () => {
  it("reproduces upstream RGB blends for dark and light palettes", () => {
    expect(codexSurfaceColor("#141619")).toBe("#303134");
    expect(codexSurfaceColor("#e7e7d9")).toBe("#ddddd0");
    expect(codexSurfaceColor("#000000", "history")).toBe("#282828");
    expect(codexSurfaceColor("garbage")).toBeNull();
  });

  it("recolors existing exact Codex fills with a renderer background below selection", () => {
    const { adapter, cells, stale, term } = setup();
    cells[0] = [
      { color: stale },
      { color: stale },
      { color: 0xaa0000 },
      { color: stale, inverse: true },
    ];
    cells[1] = [{ color: stale, indexed: true }];
    adapter.update({ enabled: true, background: "#e7e7d9" });
    expect(term.registerDecoration).toHaveBeenCalledTimes(1);
    expect(term.registerDecoration).toHaveBeenCalledWith(
      expect.objectContaining({
        x: 0,
        width: 2,
        backgroundColor: codexSurfaceColor("#e7e7d9"),
        layer: "bottom",
      }),
    );
    expect(cells[0][0].color).toBe(stale);
    adapter.dispose();
  });

  it("adapts newly painted cells and clears fills when content changes without a render loop", () => {
    const { adapter, cells, stale, term, fire, flush, decorations } = setup();
    adapter.update({ enabled: true, background: "#ffffff" });
    cells[0] = [{ color: stale }];
    fire("write");
    flush();
    expect(term.registerDecoration).toHaveBeenCalledTimes(1);
    fire("write");
    flush();
    expect(term.registerDecoration).toHaveBeenCalledTimes(1);
    cells[0] = [];
    fire("write");
    flush();
    expect(decorations[0].dispose).toHaveBeenCalledOnce();
    adapter.dispose();
  });

  it("bounds work to visible history and follows scrolling and marker movement", () => {
    const { adapter, cells, stale, term, buffer, markers, fire, flush } = setup();
    cells[0] = [{ color: stale }];
    cells[50] = [{ color: stale }];
    adapter.update({ enabled: true, background: "#ffffff" });
    expect(buffer.getLine).toHaveBeenCalledTimes(2);
    buffer.viewportY = 50;
    buffer.baseY = 90;
    fire("scroll");
    flush();
    expect(markers[0].isDisposed).toBe(true);
    expect(markers[1].line).toBe(50);
    markers[1].line = 49;
    fire("write");
    flush();
    expect(term.registerDecoration).toHaveBeenCalledTimes(3);
    adapter.dispose();
  });

  it("supports observed light startup palettes, reverse transitions, and returning to original colors", () => {
    const { adapter, cells, term } = setup();
    adapter.recordStartupBackground("rgba(231,231,217,1)");
    cells[0] = [{ color: 0xe2e2d4 }];
    adapter.update({ enabled: true, background: "#141619" });
    expect(term.registerDecoration).toHaveBeenLastCalledWith(
      expect.objectContaining({ backgroundColor: codexSurfaceColor("#141619", "history") }),
    );
    adapter.update({ enabled: true, background: "#e7e7d9" });
    expect(term.registerDecoration).toHaveBeenCalledTimes(1);
    adapter.dispose();
  });

  it("stays inactive for other agents and cleans up listeners, decorations, and pending work", () => {
    const { adapter, cells, stale, term, fire, flush, markers, subscriptionDisposals } = setup();
    cells[0] = [{ color: stale }];
    adapter.update({ enabled: false, background: "#ffffff" });
    fire("write");
    flush();
    expect(term.registerDecoration).not.toHaveBeenCalled();
    adapter.update({ enabled: true, background: "#ffffff" });
    fire("write");
    adapter.dispose();
    flush();
    expect(markers[0].isDisposed).toBe(true);
    expect(subscriptionDisposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    expect(term.registerDecoration).toHaveBeenCalledTimes(1);
  });
});

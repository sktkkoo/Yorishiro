import type { IDisposable, IMarker, Terminal } from "@xterm/xterm";

type Rgb = readonly [number, number, number];
type Surface = "composer" | "history";
type DecorationTerminal = Pick<
  Terminal,
  | "buffer"
  | "cols"
  | "rows"
  | "registerMarker"
  | "registerDecoration"
  | "onWriteParsed"
  | "onScroll"
  | "onResize"
>;

function rgb(value: string): Rgb | null {
  const hex = /^#([\da-f]{6})$/i.exec(value.trim());
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }
  const match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)$/i.exec(
    value.trim(),
  );
  if (!match) return null;
  const channels = match.slice(1, 4).map(Number);
  return channels.every((n) => n <= 255) ? (channels as unknown as Rgb) : null;
}

/** Matches Codex tui/style.rs and color.rs, including Rust f32 truncation. */
export function codexSurfaceColor(
  background: string,
  surface: Surface = "composer",
): string | null {
  const channels = rgb(background);
  if (!channels) return null;
  const light = channels[0] * 0.299 + channels[1] * 0.587 + channels[2] * 0.114 > 128;
  const alpha = Math.fround(
    light ? (surface === "composer" ? 0.04 : 0.02) : surface === "composer" ? 0.12 : 0.16,
  );
  const top = light ? 0 : 255;
  const result = channels.map((c) =>
    Math.trunc(Math.fround(Math.fround(top * alpha) + Math.fround(c * Math.fround(1 - alpha)))),
  );
  return `#${result.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

interface Run {
  line: number;
  x: number;
  width: number;
  backgroundColor: string;
}
interface PaintedRun {
  run: Run;
  marker: IMarker;
  decoration: IDisposable;
}

/**
 * Codex caches its startup OSC 11 palette. Adapt only its exact derived fills,
 * using public renderer decorations so buffer bytes/history remain untouched.
 * Decorations participate in xterm's contrast calculation and stay below selection.
 */
export class CodexThemeDecorations {
  private readonly subscriptions: IDisposable[];
  private readonly sources = new Map<number, Surface>();
  private painted: PaintedRun[] = [];
  private enabled = false;
  private background = "#141619";
  private frame: number | null = null;
  private disposed = false;
  private lastBuffer: Terminal["buffer"]["active"] | null = null;

  constructor(private readonly term: DecorationTerminal) {
    // Existing attached sessions can predate OSC-query observation.
    this.recordStartupBackground("#141619");
    this.subscriptions = [
      term.onWriteParsed(() => this.schedule()),
      term.onScroll(() => this.schedule()),
      term.onResize(() => this.schedule()),
      term.buffer.onBufferChange(() => this.schedule()),
    ];
  }

  update(options: {
    enabled: boolean;
    background: string;
    foreground?: string;
    /** Known scene palettes recover startup fills after replay or a legacy HMR upgrade. */
    sourceBackgrounds?: readonly string[];
  }): void {
    if (this.disposed) return;
    let sourcesChanged = false;
    for (const background of options.sourceBackgrounds ?? []) {
      sourcesChanged = this.rememberBackground(background) || sourcesChanged;
    }
    sourcesChanged = this.rememberBackground(options.background) || sourcesChanged;
    if (
      !sourcesChanged &&
      this.enabled === options.enabled &&
      this.background === options.background
    )
      return;
    this.enabled = options.enabled;
    this.background = options.background;
    this.refresh();
  }

  /** Call for a live Codex OSC 11 query, using the opaque palette being answered. */
  recordStartupBackground(background: string): void {
    if (this.disposed) return;
    if (this.rememberBackground(background)) this.schedule();
  }

  private rememberBackground(background: string): boolean {
    let changed = false;
    for (const surface of ["composer", "history"] as const) {
      const color = codexSurfaceColor(background, surface);
      if (!color) continue;
      const value = Number.parseInt(color.slice(1), 16);
      if (this.sources.get(value) !== surface) {
        this.sources.set(value, surface);
        changed = true;
      }
    }
    return changed;
  }

  reset(): void {
    this.sources.clear();
    this.clear();
    this.recordStartupBackground("#141619");
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.clear();
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  private schedule(): void {
    if (this.disposed || !this.enabled || this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.refresh();
    });
  }

  private clear(): void {
    for (const { decoration, marker } of this.painted) {
      decoration.dispose();
      marker.dispose();
    }
    this.painted = [];
  }

  private refresh(): void {
    const buffer = this.term.buffer.active;
    const runs: Run[] = [];
    if (this.enabled && rgb(this.background)) {
      const colors = {
        composer: codexSurfaceColor(this.background, "composer"),
        history: codexSurfaceColor(this.background, "history"),
      };
      // Scan only visible rows, including when the user scrolls into old history.
      for (
        let y = buffer.viewportY;
        y < Math.min(buffer.length, buffer.viewportY + this.term.rows);
        y++
      ) {
        const line = buffer.getLine(y);
        let run: Run | undefined;
        for (let x = 0; line && x < this.term.cols; x++) {
          const cell = line.getCell(x);
          const surface =
            cell?.isBgRGB() && !cell.isInverse() ? this.sources.get(cell.getBgColor()) : undefined;
          const backgroundColor = surface ? colors[surface] : null;
          if (
            !backgroundColor ||
            Number.parseInt(backgroundColor.slice(1), 16) === cell?.getBgColor()
          ) {
            run = undefined;
          } else if (run && run.backgroundColor === backgroundColor) {
            run.width++;
          } else {
            run = { line: y, x, width: 1, backgroundColor };
            runs.push(run);
          }
        }
      }
    }
    // onWriteParsed can fire without changing fills. Avoid render churn, and
    // compare marker positions because scrollback trimming moves them.
    if (
      this.lastBuffer === buffer &&
      runs.length === this.painted.length &&
      runs.every((run, i) => {
        const painted = this.painted[i];
        return (
          !painted.marker.isDisposed &&
          painted.marker.line === run.line &&
          painted.run.x === run.x &&
          painted.run.width === run.width &&
          painted.run.backgroundColor === run.backgroundColor
        );
      })
    )
      return;
    this.clear();
    this.lastBuffer = buffer;
    for (const run of runs) {
      const marker = this.term.registerMarker(run.line - buffer.baseY - buffer.cursorY);
      const decoration = this.term.registerDecoration({
        marker,
        x: run.x,
        width: run.width,
        backgroundColor: run.backgroundColor,
        layer: "bottom",
      });
      if (decoration) this.painted.push({ run, marker, decoration });
      else marker.dispose();
    }
  }
}

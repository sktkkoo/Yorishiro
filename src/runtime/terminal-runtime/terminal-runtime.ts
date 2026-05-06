import type { Disposable, TerminalCellData } from "@charminal/sdk";
import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import type { ITheme as XTermTheme } from "@xterm/xterm";
import { Terminal as XTerm } from "@xterm/xterm";
import {
  type SpawnSpec,
  sessionResize,
  sessionSpawn,
  sessionWrite,
} from "../../bindings/tauri-commands";
import type { Perception } from "../../core/perception";
import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import type {
  PtyParams,
  TerminalCursorClientPosition,
  TerminalLineRect,
  TerminalRuntime,
} from "./types";

const TYPING_CURSOR_ACTIVE_MS = 2000;

/** xterm.js の初期カラーテーマ。scene が未設定の時のフォールバック。 */
export const DEFAULT_TERMINAL_THEME: XTermTheme = {
  background: "#0f1923",
  foreground: "#eceff4",
  cursor: "#4dd9cf",
  cursorAccent: "#0f1923",
  selectionBackground: "#243447",
  selectionForeground: "#eceff4",
  black: "#0f1923",
  red: "#ff6b8a",
  green: "#4dd9cf",
  yellow: "#f0c674",
  blue: "#81a2be",
  magenta: "#b294bb",
  cyan: "#39c5bb",
  white: "#eceff4",
  brightBlack: "#3b5068",
  brightRed: "#ff8da5",
  brightGreen: "#6eded6",
  brightYellow: "#f5d6a0",
  brightBlue: "#a8c8e0",
  brightMagenta: "#c9aed0",
  brightCyan: "#7eeee6",
  brightWhite: "#ffffff",
};

/**
 * TerminalRuntime implementation. See types.ts for the contract.
 *
 * Key design choices (internal design-record: 2026-04-17-terminal-runtime-singleton.md):
 *   - Channel は factory 内で 1 回だけ生成し、webview lifetime で不変。React の
 *     mount lifecycle とは完全に分離する。
 *   - xterm container DOM は document.body 直下に imperative に append し、React
 *     の placeholder div の getBoundingClientRect() に ResizeObserver で追従。
 *   - updatePtyParams の差分検出で StrictMode double-mount や HMR 再実行による
 *     連続呼び出しを吸収する。
 */
class TerminalRuntimeImpl implements TerminalRuntime {
  private readonly sessionId: string;
  private readonly term: XTerm;
  private readonly fitAddon: FitAddon;
  private readonly xtermContainer: HTMLDivElement;
  private readonly channel: Channel<ArrayBuffer>;
  private readonly perceptionRef: { current: Perception | null } = { current: null };
  private readonly textDecoder = new TextDecoder("utf-8", { fatal: false });

  private currentParams: PtyParams | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeRafId = 0;
  private lastFitW = 0;
  private lastFitH = 0;
  private lastUserInputAt = -Infinity;
  private recentInput = "";
  private readonly ptyDataListeners = new Set<() => void>();
  private readonly scrollListeners = new Set<() => void>();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.term = new XTerm({
      theme: { ...DEFAULT_TERMINAL_THEME },
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
    });

    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);

    this.xtermContainer = document.createElement("div");
    this.xtermContainer.className = "xterm-singleton-container";
    this.xtermContainer.style.position = "fixed";
    this.xtermContainer.style.visibility = "hidden";
    this.xtermContainer.style.pointerEvents = "auto";
    this.xtermContainer.style.zIndex = "1";
    document.body.appendChild(this.xtermContainer);

    this.term.open(this.xtermContainer);

    try {
      const webgl = new WebglAddon();
      this.term.loadAddon(webgl);
    } catch {
      // Canvas renderer remains active as fallback.
    }

    // Channel は webview lifetime の単一 instance。factory が HMR survive するので
    // この callback ID は terminal.tsx の編集で orphan にならない。
    this.channel = new Channel<ArrayBuffer>();
    this.channel.onmessage = (data: ArrayBuffer) => {
      const bytes = new Uint8Array(data);
      this.term.write(bytes);
      this.notifyPtyDataListeners();
      const text = this.textDecoder.decode(bytes, { stream: true });
      this.perceptionRef.current?.onPtyOutput(text);
    };

    // PTY exit listener（session の process が終了したら terminal に表示）
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      await listen<{ session_id: string; code: number }>("pty-exit", (event) => {
        if (event.payload.session_id !== this.sessionId) return;
        this.term.write(`\r\n\x1b[90m[Process exited with code ${event.payload.code}]\x1b[0m\r\n`);
      });
    })();

    // ユーザー入力を PTY に流す
    let writeQueue: Promise<void> = Promise.resolve();
    this.term.onData((data) => {
      this.lastUserInputAt = performance.now();
      this.perceptionRef.current?.onUserInput(data);
      this.detectClearCommand(data);
      writeQueue = writeQueue.then(async () => {
        try {
          await sessionWrite({ sessionId: this.sessionId, data });
        } catch {
          // PTY already closed — silent
        }
      });
    });

    // viewport scroll を listener に通知（attention producer の rect 再計算 trigger 用途）
    this.term.onScroll(() => {
      for (const listener of Array.from(this.scrollListeners)) {
        listener();
      }
    });

    // xterm 側の cols/rows 変化を Rust に転送
    this.term.onResize(({ cols, rows }) => {
      void sessionResize({ sessionId: this.sessionId, cols, rows });
    });
  }

  attachTo(container: HTMLElement): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    cancelAnimationFrame(this.resizeRafId);

    const syncRect = () => {
      const rect = container.getBoundingClientRect();
      const cs = getComputedStyle(container);
      const padLeft = parseFloat(cs.paddingLeft) || 0;
      const padTop = parseFloat(cs.paddingTop) || 0;
      const padRight = parseFloat(cs.paddingRight) || 0;
      const padBottom = parseFloat(cs.paddingBottom) || 0;
      const w = Math.floor(rect.width - padLeft - padRight);
      const h = Math.floor(rect.height - padTop - padBottom);
      this.xtermContainer.style.top = `${rect.top + padTop}px`;
      this.xtermContainer.style.left = `${rect.left + padLeft}px`;
      this.xtermContainer.style.width = `${w}px`;
      this.xtermContainer.style.height = `${h}px`;
      this.xtermContainer.style.visibility = "visible";
      if (w !== this.lastFitW || h !== this.lastFitH) {
        this.lastFitW = w;
        this.lastFitH = h;
        this.fitAddon.fit();
      }
    };

    const tick = () => {
      syncRect();
      this.resizeRafId = requestAnimationFrame(tick);
    };
    this.resizeRafId = requestAnimationFrame(tick);
  }

  detachContainer(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    cancelAnimationFrame(this.resizeRafId);
    this.resizeRafId = 0;
    this.xtermContainer.style.visibility = "hidden";
  }

  /**
   * Session が close されるときに呼ぶ。xterm を dispose し、xterm container を
   * document.body から外し、ResizeObserver / RAF を停止する。Channel callback
   * は新規メッセージが来てももう参照しないので残しておいて GC に任せる。
   */
  dispose(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    cancelAnimationFrame(this.resizeRafId);
    this.resizeRafId = 0;
    this.ptyDataListeners.clear();
    this.scrollListeners.clear();
    this.term.dispose();
    if (this.xtermContainer.parentElement) {
      this.xtermContainer.parentElement.removeChild(this.xtermContainer);
    }
  }

  updatePtyParams(params: PtyParams): void {
    if (this.paramsEqual(this.currentParams, params)) {
      return;
    }
    this.currentParams = params;
    this.term.reset();

    void (async () => {
      try {
        await sessionSpawn({
          sessionId: this.sessionId,
          spec: params.spec,
          cols: this.term.cols,
          rows: this.term.rows,
          cwd: params.cwd,
          onOutput: this.channel,
        });
      } catch (err) {
        const label = describeSpec(params.spec);
        this.term.write(`\x1b[31mFailed to start ${label}: ${err}\x1b[0m\r\n`);
        this.term.write(`\x1b[90mMake sure ${label} is installed and in your PATH.\x1b[0m\r\n`);
      }
    })();
  }

  setPerception(perception: Perception | null): void {
    if (perception === null) {
      console.warn(
        "[terminal-runtime] setPerception(null) — reflex layer input will be suppressed",
      );
    }
    this.perceptionRef.current = perception;
  }

  setTheme(theme: Partial<XTermTheme>): void {
    this.term.options.theme = { ...this.term.options.theme, ...theme };
  }

  getInputCursorClientPosition(): TerminalCursorClientPosition | null {
    const sinceInput = performance.now() - this.lastUserInputAt;
    if (sinceInput > TYPING_CURSOR_ACTIVE_MS) {
      return null;
    }

    const buffer = this.term.buffer.active;
    if (!buffer) {
      return null;
    }

    const rect = this.xtermContainer.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return null;
    }

    const cellWidth = rect.width / this.term.cols;
    const cellHeight = rect.height / this.term.rows;
    const col = Math.max(0, Math.min(this.term.cols - 1, buffer.cursorX));
    const row = Math.max(0, Math.min(this.term.rows - 1, buffer.cursorY));

    return {
      clientX: rect.left + (col + 0.5) * cellWidth,
      clientY: rect.top + (row + 0.5) * cellHeight,
      cellWidth,
      cellHeight,
    };
  }

  extractVisibleCells(): TerminalCellData | null {
    const buffer = this.term.buffer.active;
    if (!buffer) return null;

    const rect = this.xtermContainer.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    const cellWidth = rect.width / this.term.cols;
    const cellHeight = rect.height / this.term.rows;

    const DEFAULT_FG = "#eceff4";
    const ANSI_COLORS: Record<number, string> = {
      0: "#0f1923",
      1: "#ff6b8a",
      2: "#4dd9cf",
      3: "#f0c674",
      4: "#81a2be",
      5: "#b294bb",
      6: "#39c5bb",
      7: "#eceff4",
      8: "#3b5068",
      9: "#ff8da5",
      10: "#6eded6",
      11: "#f5d6a0",
      12: "#a8c8e0",
      13: "#c9aed0",
      14: "#7eeee6",
      15: "#ffffff",
    };

    const cells: Array<{
      char: string;
      x: number;
      y: number;
      row: number;
      col: number;
      fgColor: string;
    }> = [];

    for (let row = 0; row < this.term.rows; row++) {
      const line = buffer.getLine(buffer.viewportY + row);
      if (!line) continue;
      for (let col = 0; col < this.term.cols; col++) {
        const cell = line.getCell(col);
        if (!cell) continue;
        const ch = cell.getChars();
        if (!ch || ch === " ") continue;

        let fgColor = DEFAULT_FG;
        if (!cell.isFgDefault()) {
          const idx = cell.getFgColor();
          fgColor = ANSI_COLORS[idx] ?? DEFAULT_FG;
        }

        cells.push({
          char: ch,
          x: col * cellWidth,
          y: row * cellHeight,
          row,
          col,
          fgColor,
        });
      }
    }

    return {
      cells,
      cellWidth,
      cellHeight,
      terminalRect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
      cols: this.term.cols,
      rows: this.term.rows,
    };
  }

  getViewportLineRects(): ReadonlyArray<TerminalLineRect> {
    const buffer = this.term.buffer.active;
    if (!buffer) return [];

    const containerRect = this.xtermContainer.getBoundingClientRect();
    if (containerRect.width === 0 || containerRect.height === 0) return [];

    const cellWidth = containerRect.width / this.term.cols;
    const cellHeight = containerRect.height / this.term.rows;

    const result: TerminalLineRect[] = [];

    for (let row = this.term.rows - 1; row >= 0; row--) {
      const line = buffer.getLine(buffer.viewportY + row);
      if (!line) continue;

      let startCol = -1;
      let endCol = -1;
      for (let col = 0; col < this.term.cols; col++) {
        const cell = line.getCell(col);
        const ch = cell?.getChars() ?? "";
        if (ch !== "" && ch !== " ") {
          if (startCol === -1) startCol = col;
          endCol = col;
        }
      }

      if (startCol === -1 || endCol === -1) continue;

      result.push({
        text: line.translateToString(true),
        rect: {
          x: containerRect.left + startCol * cellWidth,
          y: containerRect.top + row * cellHeight,
          width: Math.max(cellWidth, (endCol - startCol + 1) * cellWidth),
          height: cellHeight,
        },
      });
    }

    return result;
  }

  subscribePtyData(listener: () => void): Disposable {
    this.ptyDataListeners.add(listener);
    return {
      dispose: () => {
        this.ptyDataListeners.delete(listener);
      },
    };
  }

  subscribeViewportScroll(listener: () => void): Disposable {
    this.scrollListeners.add(listener);
    return {
      dispose: () => {
        this.scrollListeners.delete(listener);
      },
    };
  }

  writePlainText(text: string): void {
    this.term.write(text);
  }

  focus(): void {
    this.term.focus();
  }

  private notifyPtyDataListeners(): void {
    for (const listener of Array.from(this.ptyDataListeners)) {
      listener();
    }
  }

  private detectClearCommand(data: string): void {
    if (data.includes("\r") || data.includes("\n")) {
      const line = this.recentInput.trim();
      if (line === "/clear" || line === "/compact") {
        this.term.clear();
      }
      this.recentInput = "";
    } else if (data === "\x7f") {
      // Backspace
      this.recentInput = this.recentInput.slice(0, -1);
    } else if (data.length === 1 && data >= " ") {
      this.recentInput += data;
      if (this.recentInput.length > 50) {
        this.recentInput = this.recentInput.slice(-50);
      }
    }
  }

  private paramsEqual(a: PtyParams | null, b: PtyParams): boolean {
    if (a === null) return false;
    return a.cwd === b.cwd && specEqual(a.spec, b.spec);
  }
}

function specEqual(a: SpawnSpec, b: SpawnSpec): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "agent" && b.kind === "agent") {
    return (
      a.agent === b.agent &&
      (a.command ?? null) === (b.command ?? null) &&
      (a.systemPrompt ?? null) === (b.systemPrompt ?? null)
    );
  }
  if (a.kind === "shell" && b.kind === "shell") {
    return (
      (a.command ?? null) === (b.command ?? null) &&
      (a.integration ?? true) === (b.integration ?? true)
    );
  }
  return false;
}

function describeSpec(spec: SpawnSpec): string {
  if (spec.kind === "agent") return spec.agent;
  return spec.command ?? "shell";
}

/**
 * Session id でキーされる TerminalRuntime instance の Map。HMR 越しに instance
 * を保つため hot-data 経由で保持する。
 */
function getRuntimeMap(): Map<string, TerminalRuntimeImpl> {
  return getOrInit(KEYS.TERMINAL_RUNTIME, () => new Map<string, TerminalRuntimeImpl>());
}

/**
 * Session に紐づく TerminalRuntime を返す。同 sessionId への二度目の呼び出しは
 * 同じ instance を返す（webview lifetime singleton per session）。
 */
export function getTerminalRuntime(sessionId: string): TerminalRuntime {
  const map = getRuntimeMap();
  let runtime = map.get(sessionId);
  if (!runtime) {
    runtime = new TerminalRuntimeImpl(sessionId);
    map.set(sessionId, runtime);
  }
  return runtime;
}

/**
 * 現在生きている全 TerminalRuntime instance を返す。テーマ一括適用などに使う。
 */
export function getAllTerminalRuntimes(): ReadonlyArray<TerminalRuntime> {
  return [...getRuntimeMap().values()];
}

/**
 * Session が close されたとき呼んで instance を解放する。xterm.dispose / DOM 解放 /
 * channel 破棄を行い Map から外す。同 sessionId が無ければ no-op。
 */
export function disposeTerminalRuntime(sessionId: string): void {
  const map = getRuntimeMap();
  const runtime = map.get(sessionId);
  if (!runtime) return;
  runtime.dispose();
  map.delete(sessionId);
}

// Self-accept: terminal-runtime.ts 自身を編集しても Map は保たれる。
// React 側は影響なく次 mount で同 instance を引く。
if (import.meta.hot) {
  import.meta.hot.accept();
}

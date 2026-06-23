import type { Disposable, TerminalCellData } from "@charminal/sdk";
import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import type { ITheme as XTermTheme } from "@xterm/xterm";
import { Terminal as XTerm } from "@xterm/xterm";
import {
  type SpawnSpec,
  sessionAttach,
  sessionDestroy,
  sessionRefreshTheme,
  sessionResize,
  sessionSpawn,
  sessionWrite,
} from "../../bindings/tauri-commands";
import type { Perception } from "../../core/perception";
import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import { resolveCommandRunMenuPosition } from "./command-run-menu-position";
import { type TerminalCommandRun, TerminalCommandRunStore } from "./command-run-store";
import { decodeOsc633Value } from "./osc633";
import {
  type OscNotificationCode,
  type TerminalNotification as ParsedTerminalNotification,
  parseOscNotification,
} from "./osc-notification";
import { extractRegionText, polygonBounds, type RegionPoint } from "./region-selection";
import { detectTerminalProblems, type TerminalProblem } from "./terminal-problems";
import type {
  PtyParams,
  TerminalCommandRunLocus,
  TerminalCursorClientPosition,
  TerminalLineRect,
  TerminalNotificationEvent,
  TerminalReference,
  TerminalRegionContext,
  TerminalRuntime,
  UpdatePtyOptions,
} from "./types";

const TYPING_CURSOR_ACTIVE_MS = 2000;
const IME_POST_COMMIT_SUPPRESS_MS = 80;

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
  private readonly regionCanvas: HTMLCanvasElement | null;
  private readonly regionCtx: CanvasRenderingContext2D | null;
  private readonly channel: Channel<ArrayBuffer>;
  private readonly perceptionRef: { current: Perception | null } = { current: null };
  private readonly textDecoder = new TextDecoder("utf-8", { fatal: false });
  private readonly commandRuns: TerminalCommandRunStore;
  private readonly oscHandlerDisposables: Disposable[] = [];
  private hoveredCommandRunId: number | null = null;
  private hoverProbeLine: number | null = null;
  private readonly commandRunProblems = new Map<number, ReadonlyArray<TerminalProblem>>();
  private commandRunMenuTargets: ReadonlyArray<{
    readonly sessionId: string;
    readonly label: string;
  }> = [];
  private commandRunMenu: HTMLElement | null = null;
  private commandRunMenuDismiss: ((event: Event) => void) | null = null;
  private attachLiveBuffer: Uint8Array[] | null = null;
  private readonly ptyWriteQueue: Array<{ readonly bytes: Uint8Array; readonly replay: boolean }> =
    [];
  private writingPtyChunk = false;
  private currentWriteReplay = false;

  private currentParams: PtyParams | null = null;
  private attachedContainer: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeRafId = 0;
  private lastFitW = 0;
  private lastFitH = 0;
  private lastUserInputAt = -Infinity;
  private recentInput = "";
  private readonly ptyDataListeners = new Set<() => void>();
  private readonly notificationListeners = new Set<(event: TerminalNotificationEvent) => void>();
  private readonly userInputListeners = new Set<(data: string) => void>();
  private readonly scrollListeners = new Set<() => void>();
  private readonly activationListeners = new Set<() => void>();
  private readonly regionContextListeners = new Set<(context: TerminalRegionContext) => void>();
  private readonly commandRunStartedListeners = new Set<(run: TerminalCommandRun) => void>();
  private readonly commandRunFinalizedListeners = new Set<(run: TerminalCommandRun) => void>();
  private disposed = false;
  private hidden = false;
  private opacity = 1;
  private bgTransparent = false;
  /** 直近 setTheme でマージされた背景色。bgTransparent 解除時の復帰先。 */
  private currentThemeBackground: string | undefined;
  private startGeneration = 0;
  private ptyExitUnlisten: (() => void) | null = null;
  private regionDrag: {
    readonly pointerId: number;
    readonly start: RegionPoint;
    current: RegionPoint;
  } | null = null;
  private clearRegionCanvasTimeout: number | null = null;
  private latestRegionContext: TerminalRegionContext | null = null;
  private terminalReferenceCounter = 0;
  private readonly terminalReferences = new Map<string, TerminalReference>();
  private inputWriteQueue: Promise<void> = Promise.resolve();
  private imeComposing = false;
  private imePendingCommitText: string | null = null;
  private imePendingCommitTimer: number | null = null;
  private imeSuppressPrintableUntil = -Infinity;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.commandRuns = new TerminalCommandRunStore(sessionId);
    this.term = new XTerm({
      theme: { ...DEFAULT_TERMINAL_THEME },
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      // 透明 background を合成可能にする。不透明 background のときは描画結果が
      // 同一（無害）で、setBackgroundTransparent(true) で初めて効く。
      allowTransparency: true,
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
    this.xtermContainer.addEventListener("pointerdown", this.handleActivationEvent);
    this.xtermContainer.addEventListener("focusin", this.handleActivationEvent);

    this.term.open(this.xtermContainer);
    this.installImeCompositionGuard();
    this.installCommandRunOscHandlers();
    this.installNotificationOscHandlers();

    const regionCtx = this.createRegionCanvas();
    this.regionCanvas = regionCtx?.canvas ?? null;
    this.regionCtx = regionCtx?.context ?? null;
    if (regionCtx) {
      this.installRegionSelectionHandlers();
    }

    // Channel は webview lifetime の単一 instance。factory が HMR survive するので
    // この callback ID は terminal.tsx の編集で orphan にならない。
    this.channel = new Channel<ArrayBuffer>();
    this.channel.onmessage = (data: ArrayBuffer) => {
      if (this.disposed) return;
      const bytes = new Uint8Array(data);
      if (this.attachLiveBuffer !== null) {
        this.attachLiveBuffer.push(bytes);
        return;
      }
      this.handlePtyBytes(bytes, { replay: false });
    };

    // PTY exit listener（session の process が終了したら terminal に表示）
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<{ session_id: string; code: number }>("pty-exit", (event) => {
        if (this.disposed) return;
        if (event.payload.session_id !== this.sessionId) return;
        this.finalizeCommandRun("pty-exit", normalizePtyExitCode(event.payload.code));
        this.term.write(`\r\n\x1b[90m[Process exited with code ${event.payload.code}]\x1b[0m\r\n`);
      });
      if (this.disposed) {
        unlisten();
      } else {
        this.ptyExitUnlisten = unlisten;
      }
    })();

    // ユーザー入力を PTY に流す。IME composition 中の romanized leak は guard する。
    this.term.onData((data) => {
      if (this.disposed) return;
      const filtered = this.filterImeData(data);
      if (filtered === null) return;
      this.acceptUserInputData(filtered);
    });

    // viewport scroll を listener に通知（attention producer の rect 再計算 trigger 用途）
    this.term.onScroll(() => {
      // scroll すると行が動くので hover ハイライトは一旦消す（pointermove で再 hover）。
      this.setHoveredCommandRun(null);
      for (const listener of Array.from(this.scrollListeners)) {
        listener();
      }
    });

    // xterm 側の cols/rows 変化を Rust に転送
    this.term.onResize(({ cols, rows }) => {
      if (this.disposed) return;
      void sessionResize({ sessionId: this.sessionId, cols, rows });
    });
  }

  attachTo(container: HTMLElement): void {
    if (this.disposed) return;
    this.attachedContainer = container;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    cancelAnimationFrame(this.resizeRafId);
    this.resizeRafId = 0;

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        this.syncAttachedRect();
      });
      this.resizeObserver.observe(container);
    }
    window.addEventListener("resize", this.handleViewportResize);
    this.syncAttachedRect();
  }

  detachContainer(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener("resize", this.handleViewportResize);
    cancelAnimationFrame(this.resizeRafId);
    this.resizeRafId = 0;
    this.attachedContainer = null;
    this.xtermContainer.style.visibility = "hidden";
  }

  /**
   * layout 由来の表示/非表示。session active 状態（attach/detach）とは独立。
   * hidden 中は singleton xtermContainer を visibility:hidden に固定し、
   * syncAttachedRect の per-frame visibility 強制もこのフラグに従う。
   */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.xtermContainer.style.visibility = hidden ? "hidden" : "visible";
  }

  /**
   * layout 由来の terminal 全体不透明度（0-1）。1 で完全不透明。
   * .xterm-singleton-container の style.opacity を直接設定し、フラグも保持する
   * （attach/detach をまたいで維持。syncAttachedRect は opacity を触らないので安全）。
   */
  setOpacity(opacity: number): void {
    this.opacity = opacity;
    this.xtermContainer.style.opacity = String(opacity);
  }

  getOpacity(): number {
    return this.opacity;
  }

  /**
   * layout 由来：terminal の背景のみ透明にする（文字は前景色で不透明のまま）。
   * xterm theme.background を透明色にし、singleton container の CSS 背景も透明化する。
   * setTheme は scene 由来の不透明 background を上書きするため、bgTransparent 中は
   * setTheme 後に再適用する（hidden/opacity の flag-reassert と同型）。
   */
  setBackgroundTransparent(transparent: boolean): void {
    this.bgTransparent = transparent;
    this.applyBackgroundTransparency();
  }

  /**
   * bgTransparent フラグを theme.background と container の見た目に反映する。
   * 透明時は theme.background を rgba(0,0,0,0) にし、背景を塗る各 xterm child を
   * scoped class で透過させる。解除時は直近 setTheme の背景色（無ければ既定）へ戻す。
   */
  private applyBackgroundTransparency(): void {
    if (this.bgTransparent) {
      this.term.options.theme = { ...this.term.options.theme, background: "rgba(0,0,0,0)" };
      this.xtermContainer.style.background = "transparent";
    } else {
      const restored = this.currentThemeBackground ?? DEFAULT_TERMINAL_THEME.background;
      this.term.options.theme = { ...this.term.options.theme, background: restored };
      // 空文字で inline 背景を外し CSS（--charminal-bg）へ戻す。
      this.xtermContainer.style.background = "";
    }
    this.xtermContainer.classList.toggle("xterm-bg-transparent", this.bgTransparent);
  }

  /**
   * Session が close されるときに呼ぶ。xterm を dispose し、xterm container を
   * document.body から外し、ResizeObserver / RAF を停止する。Channel callback
   * は新規メッセージが来てももう参照しないので残しておいて GC に任せる。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.startGeneration++;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener("resize", this.handleViewportResize);
    cancelAnimationFrame(this.resizeRafId);
    this.resizeRafId = 0;
    this.ptyExitUnlisten?.();
    this.ptyExitUnlisten = null;
    this.finalizeCommandRunForSessionDispose();
    this.clearPtyWriteQueue();
    this.clearCommandRunDecorations();
    for (const disposable of this.oscHandlerDisposables.splice(0)) {
      disposable.dispose();
    }
    this.commandRuns.clear();
    this.ptyDataListeners.clear();
    this.scrollListeners.clear();
    this.activationListeners.clear();
    this.regionContextListeners.clear();
    this.notificationListeners.clear();
    this.userInputListeners.clear();
    this.commandRunStartedListeners.clear();
    this.commandRunFinalizedListeners.clear();
    this.xtermContainer.removeEventListener("pointerdown", this.handleActivationEvent);
    this.xtermContainer.removeEventListener("focusin", this.handleActivationEvent);
    this.clearImePendingCommitTimer();
    if (this.clearRegionCanvasTimeout !== null) {
      window.clearTimeout(this.clearRegionCanvasTimeout);
      this.clearRegionCanvasTimeout = null;
    }
    this.term.dispose();
    if (this.xtermContainer.parentElement) {
      this.xtermContainer.parentElement.removeChild(this.xtermContainer);
    }
  }

  updatePtyParams(params: PtyParams, options: UpdatePtyOptions = {}): void {
    if (this.disposed) return;
    if (this.paramsEqual(this.currentParams, params)) {
      return;
    }
    this.currentParams = params;
    this.startPty(params, { attachFirst: options.attachFirst === true });
  }

  private startPty(params: PtyParams, opts: { attachFirst: boolean }): void {
    if (this.disposed) return;
    const generation = ++this.startGeneration;
    this.clearPtyWriteQueue();
    this.clearCommandRunDecorations();
    this.commandRuns.clear();
    this.term.reset();

    void (async () => {
      try {
        if (this.isStaleStart(generation)) return;
        if (this.attachedContainer) {
          this.syncAttachedRect();
        }
        if (opts.attachFirst) {
          this.attachLiveBuffer = [];
          try {
            const result = await sessionAttach({
              sessionId: this.sessionId,
              cwd: params.cwd,
              onOutput: this.channel,
            });
            const bufferedLive = this.attachLiveBuffer;
            this.attachLiveBuffer = null;
            if (this.disposed && result.attached) {
              void sessionDestroy({ sessionId: this.sessionId });
              return;
            }
            if (this.isStaleStart(generation)) return;
            if (result.attached) {
              this.handlePtyBytes(new Uint8Array(result.replay), { replay: true });
              for (const liveBytes of bufferedLive) {
                this.handlePtyBytes(liveBytes, { replay: false });
              }
              this.resyncAttachedPtyDisplay();
              return;
            }
          } catch {
            this.attachLiveBuffer = null;
          }
          this.attachLiveBuffer = null;
        }
        if (this.attachedContainer) {
          this.syncAttachedRect();
        }
        if (this.isStaleStart(generation)) return;
        const cols = Math.max(2, this.term.cols || 80);
        const rows = Math.max(1, this.term.rows || 24);
        await sessionSpawn({
          sessionId: this.sessionId,
          spec: params.spec,
          cols,
          rows,
          cwd: params.cwd,
          onOutput: this.channel,
        });
        if (this.disposed) {
          void sessionDestroy({ sessionId: this.sessionId });
        }
      } catch (err) {
        if (this.isStaleStart(generation)) return;
        const label = describeSpec(params.spec);
        this.term.write(`\x1b[31mFailed to start ${label}: ${err}\x1b[0m\r\n`);
        this.term.write(`\x1b[90mMake sure ${label} is installed and in your PATH.\x1b[0m\r\n`);
      }
    })();
  }

  private resyncAttachedPtyDisplay(): void {
    if (this.disposed) return;
    // WebView reload 後の attach では xterm の画面だけが新しくなる。OpenCode などの
    // full-screen TUI は replay だけで復元しきれないため、PTY resize で再描画を促す。
    if (this.attachedContainer) {
      this.syncAttachedRect();
    }
    const cols = Math.max(2, this.term.cols || 80);
    const rows = Math.max(1, this.term.rows || 24);
    void sessionResize({ sessionId: this.sessionId, cols, rows }).catch(() => {});
    void sessionRefreshTheme({ sessionId: this.sessionId }).catch(() => {});
    this.term.refresh(0, this.term.rows - 1);
  }

  setPerception(perception: Perception | null): void {
    if (this.disposed) return;
    if (perception === null) {
      console.warn(
        "[terminal-runtime] setPerception(null) — reflex layer input will be suppressed",
      );
    }
    this.perceptionRef.current = perception;
  }

  setTheme(theme: Partial<XTermTheme>): void {
    if (this.disposed) return;
    this.term.options.theme = { ...this.term.options.theme, ...theme };
    // bgTransparent 解除時の復帰先。merged theme から拾うと、bgTransparent 中に
    // background キーを持たない partial setTheme が来たとき stale な
    // "rgba(0,0,0,0)" を復帰先に焼き込んでしまう（stuck-transparent）。
    // 引数 theme が明示的に string background を運んだときだけ更新する。
    if (typeof theme.background === "string") {
      this.currentThemeBackground = theme.background;
    }
    // bgTransparent が立っているなら scene 由来の不透明 background を透明で
    // 再上書きする（hidden/opacity の flag-reassert と同型）。
    this.applyBackgroundTransparency();
    // Theme update can leave renderer dimensions stale when scene switches
    // coincide with layout changes, so force a fresh fit before refresh.
    this.refit();
    this.term.refresh(0, this.term.rows - 1);
  }

  refit(): void {
    if (this.disposed) return;
    this.lastFitW = 0;
    this.lastFitH = 0;
    this.syncAttachedRect();
    cancelAnimationFrame(this.resizeRafId);
    this.resizeRafId = requestAnimationFrame(() => {
      this.resizeRafId = 0;
      this.lastFitW = 0;
      this.lastFitH = 0;
      this.syncAttachedRect();
      this.term.refresh(0, this.term.rows - 1);
    });
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

  readScreenTailText(maxLines = 28): string {
    const buffer = this.term.buffer.active;
    if (!buffer) return "";
    const rows = Math.max(0, Math.min(maxLines, this.term.rows));
    const start = Math.max(0, this.term.rows - rows);
    const lines: string[] = [];
    for (let row = start; row < this.term.rows; row++) {
      const line = buffer.getLine(buffer.viewportY + row);
      lines.push(line?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  }

  getLatestRegionContext(): TerminalRegionContext | null {
    return this.latestRegionContext;
  }

  subscribeRegionContext(listener: (context: TerminalRegionContext) => void): Disposable {
    this.regionContextListeners.add(listener);
    return {
      dispose: () => {
        this.regionContextListeners.delete(listener);
      },
    };
  }

  getTerminalReferences(): ReadonlyArray<TerminalReference> {
    return Array.from(this.terminalReferences.values());
  }

  getCommandRunsRecent(limit?: number): ReadonlyArray<TerminalCommandRun> {
    return this.commandRuns.getRecent(limit);
  }

  getCommandRunLocus(runId: number): TerminalCommandRunLocus | null {
    const run = this.commandRuns.getRecent().find((candidate) => candidate.id === runId);
    if (!run) return null;
    return this.buildCommandRunLocus(run);
  }

  scrollToAdjacentCommandRun(
    direction: "next" | "previous",
    opts?: { readonly failedOnly?: boolean },
  ): boolean {
    if (this.disposed) return false;
    const buffer = this.term.buffer.active;
    if (!buffer) return false;
    const viewportY = buffer.viewportY;

    // jump の anchor は run の開始行（startMarker.line）。disposed marker (line < 0) は除外。
    // failedOnly のときは失敗 run だけを対象にする。
    const anchors: number[] = [];
    for (const run of this.commandRuns.getRecent()) {
      if (opts?.failedOnly && run.status !== "failed") continue;
      const line = run.startMarker?.line ?? -1;
      if (line >= 0) anchors.push(line);
    }
    if (anchors.length === 0) return false;

    // 現在 viewport より下/上にある最も近い anchor を選ぶ。
    let target: number | null = null;
    if (direction === "next") {
      for (const line of anchors) {
        if (line > viewportY && (target === null || line < target)) target = line;
      }
    } else {
      for (const line of anchors) {
        if (line < viewportY && (target === null || line > target)) target = line;
      }
    }
    if (target === null) return false;

    this.term.scrollToLine(target);
    return true;
  }

  attachLastFailedRun(): boolean {
    const run = this.commandRuns.getLastFailedRun();
    if (!run) return false;
    return this.captureCommandRunContext(run);
  }

  attachCommandRunOutput(runId: number): boolean {
    const run = this.commandRuns.getRecent().find((candidate) => candidate.id === runId);
    if (!run) return false;
    return this.captureCommandRunContext(run);
  }

  subscribeCommandRunStarted(listener: (run: TerminalCommandRun) => void): Disposable {
    this.commandRunStartedListeners.add(listener);
    return {
      dispose: () => {
        this.commandRunStartedListeners.delete(listener);
      },
    };
  }

  subscribeCommandRunFinalized(listener: (run: TerminalCommandRun) => void): Disposable {
    this.commandRunFinalizedListeners.add(listener);
    return {
      dispose: () => {
        this.commandRunFinalizedListeners.delete(listener);
      },
    };
  }

  clearTerminalReferences(): void {
    this.terminalReferences.clear();
    this.terminalReferenceCounter = 0;
  }

  subscribePtyData(listener: () => void): Disposable {
    this.ptyDataListeners.add(listener);
    return {
      dispose: () => {
        this.ptyDataListeners.delete(listener);
      },
    };
  }

  subscribeNotification(listener: (event: TerminalNotificationEvent) => void): Disposable {
    this.notificationListeners.add(listener);
    return {
      dispose: () => {
        this.notificationListeners.delete(listener);
      },
    };
  }

  subscribeUserInput(listener: (data: string) => void): Disposable {
    this.userInputListeners.add(listener);
    return {
      dispose: () => {
        this.userInputListeners.delete(listener);
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
    if (this.disposed) return;
    this.term.write(text);
  }

  focus(): void {
    if (this.disposed) return;
    this.term.focus();
  }

  subscribeActivation(listener: () => void): Disposable {
    this.activationListeners.add(listener);
    return {
      dispose: () => {
        this.activationListeners.delete(listener);
      },
    };
  }

  forceRespawn(): void {
    if (this.disposed) return;
    if (!this.currentParams) return;
    this.startPty(this.currentParams, { attachFirst: false });
  }

  private isStaleStart(generation: number): boolean {
    return this.disposed || generation !== this.startGeneration;
  }

  private notifyPtyDataListeners(): void {
    for (const listener of Array.from(this.ptyDataListeners)) {
      listener();
    }
  }

  private installNotificationOscHandlers(): void {
    if (!this.term.parser) return;
    this.oscHandlerDisposables.push(
      this.term.parser.registerOscHandler(9, (data) => this.handleNotificationOsc(9, data)),
      this.term.parser.registerOscHandler(99, (data) => this.handleNotificationOsc(99, data)),
      this.term.parser.registerOscHandler(777, (data) => this.handleNotificationOsc(777, data)),
    );
  }

  private handleNotificationOsc(code: OscNotificationCode, data: string): boolean {
    const notification = parseOscNotification(code, data);
    if (notification === null) return false;
    this.notifyNotificationListeners(notification);
    return true;
  }

  private notifyNotificationListeners(notification: ParsedTerminalNotification): void {
    const event: TerminalNotificationEvent = {
      sessionId: this.sessionId,
      title: notification.title,
      body: notification.body,
      receivedAt: Date.now(),
    };
    for (const listener of Array.from(this.notificationListeners)) {
      listener(event);
    }
  }

  private notifyUserInputListeners(data: string): void {
    for (const listener of Array.from(this.userInputListeners)) {
      listener(data);
    }
  }

  // Tauri WebView can leak romanized IME key data through xterm before the committed text arrives.
  private installImeCompositionGuard(): void {
    const textarea = this.term.textarea;
    if (!textarea) return;

    textarea.addEventListener("compositionstart", () => {
      this.imeComposing = true;
      this.imePendingCommitText = null;
      this.clearImePendingCommitTimer();
    });

    textarea.addEventListener("compositionend", (event) => {
      this.imeComposing = false;

      const committedText = event.data;
      if (committedText.length === 0) return;

      this.imeSuppressPrintableUntil = performance.now() + IME_POST_COMMIT_SUPPRESS_MS;
      this.imePendingCommitText = committedText;
      this.clearImePendingCommitTimer();
      this.imePendingCommitTimer = window.setTimeout(() => {
        this.imePendingCommitTimer = null;
        this.flushPendingImeCommit();
      }, 0);
    });

    this.term.attachCustomKeyEventHandler((event) => {
      if (this.shouldSuppressImeKeyEvent(event)) return false;
      return true;
    });
  }

  private shouldSuppressImeKeyEvent(event: KeyboardEvent): boolean {
    if (!this.isPrintableKeyboardEvent(event)) return false;
    if (this.imeComposing || event.isComposing) return true;
    return performance.now() <= this.imeSuppressPrintableUntil;
  }

  private isPrintableKeyboardEvent(event: KeyboardEvent): boolean {
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    return event.key.length === 1;
  }

  private filterImeData(data: string): string | null {
    if (this.imeComposing) {
      return null;
    }

    const pendingText = this.imePendingCommitText;
    if (pendingText !== null) {
      this.imePendingCommitText = null;
      this.clearImePendingCommitTimer();
      this.imeSuppressPrintableUntil = performance.now() + IME_POST_COMMIT_SUPPRESS_MS;
      if (this.containsControlData(data)) {
        this.acceptUserInputData(pendingText);
        return null;
      }
      return pendingText;
    }

    if (performance.now() <= this.imeSuppressPrintableUntil && this.isPrintableTerminalData(data)) {
      return null;
    }

    return data;
  }

  private flushPendingImeCommit(): void {
    const pendingText = this.imePendingCommitText;
    if (pendingText === null || this.disposed) return;
    this.imePendingCommitText = null;
    this.imeSuppressPrintableUntil = performance.now() + IME_POST_COMMIT_SUPPRESS_MS;
    this.acceptUserInputData(pendingText);
  }

  private clearImePendingCommitTimer(): void {
    if (this.imePendingCommitTimer === null) return;
    window.clearTimeout(this.imePendingCommitTimer);
    this.imePendingCommitTimer = null;
  }

  private containsControlData(data: string): boolean {
    for (let i = 0; i < data.length; i++) {
      const code = data.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) return true;
    }
    return false;
  }

  private isPrintableTerminalData(data: string): boolean {
    return data.length > 0 && !this.containsControlData(data);
  }

  private acceptUserInputData(data: string): void {
    this.lastUserInputAt = performance.now();
    this.perceptionRef.current?.onUserInput(data);
    this.notifyUserInputListeners(data);
    this.detectClearCommand(data);
    this.inputWriteQueue = this.inputWriteQueue.then(async () => {
      try {
        await sessionWrite({ sessionId: this.sessionId, data });
      } catch {
        // PTY already closed — silent
      }
    });
  }

  private handlePtyBytes(bytes: Uint8Array, opts: { replay: boolean }): void {
    if (bytes.length === 0) return;
    this.ptyWriteQueue.push({ bytes, replay: opts.replay });
    this.flushPtyWriteQueue();
    this.notifyPtyDataListeners();
    if (opts.replay) return;
    const text = this.textDecoder.decode(bytes, { stream: true });
    this.perceptionRef.current?.onPtyOutput(text);
  }

  private flushPtyWriteQueue(): void {
    if (this.disposed || this.writingPtyChunk) return;
    const next = this.ptyWriteQueue.shift();
    if (!next) return;
    this.writingPtyChunk = true;
    this.currentWriteReplay = next.replay;
    this.term.write(next.bytes, () => {
      this.currentWriteReplay = false;
      this.writingPtyChunk = false;
      this.flushPtyWriteQueue();
    });
  }

  private clearPtyWriteQueue(): void {
    this.ptyWriteQueue.length = 0;
    this.writingPtyChunk = false;
    this.currentWriteReplay = false;
  }

  private installCommandRunOscHandlers(): void {
    this.oscHandlerDisposables.push(
      this.term.parser.registerOscHandler(133, (data) => this.handleOsc133(data)),
      this.term.parser.registerOscHandler(633, (data) => this.handleOsc633(data)),
    );
  }

  private handleOsc133(data: string): boolean {
    if (data === "C") {
      if (this.commandRunEnabled()) {
        this.startCommandRun();
      }
      return true;
    }
    if (data === "D" || data.startsWith("D;")) {
      if (this.commandRunEnabled()) {
        this.finalizeCommandRun("osc133", parseOsc133ExitCode(data));
      }
      return true;
    }
    return false;
  }

  private handleOsc633(data: string): boolean {
    if (data.startsWith("E;")) {
      if (this.commandRunEnabled()) {
        this.commandRuns.setPendingCommand(decodeOsc633Value(data.slice(2)));
      }
      return true;
    }
    if (data.startsWith("P;")) {
      if (this.commandRunEnabled()) {
        this.commandRuns.setCurrentCwd(parseOsc633Cwd(data.slice(2)));
      }
      return true;
    }
    return false;
  }

  private commandRunEnabled(): boolean {
    const spec = this.currentParams?.spec;
    return spec?.kind === "shell" && (spec.integration ?? true) === true;
  }

  private startCommandRun(): void {
    const hadActiveRun = this.commandRuns.getActiveRun() !== null;
    const started = this.commandRuns.start({
      startMarker: this.registerMarkerOrNull(),
      startedAt: this.currentWriteReplay ? null : Date.now(),
    });
    if (hadActiveRun || this.currentWriteReplay) return;
    for (const listener of Array.from(this.commandRunStartedListeners)) {
      listener(started);
    }
  }

  /** finalize した run の出力から Terminal Problems を検出して保持する（live のみ）。 */
  private detectAndStoreProblems(run: TerminalCommandRun): void {
    const context = this.buildCommandRunContext(run);
    if (!context) return;
    const problems = detectTerminalProblems(context.text);
    if (problems.length > 0) this.commandRunProblems.set(run.id, problems);
  }

  /** 指定 run で検出された Terminal Problems（file/url/port/test-fail）。無ければ空配列。 */
  getCommandRunProblems(runId: number): ReadonlyArray<TerminalProblem> {
    return this.commandRunProblems.get(runId) ?? [];
  }

  private finalizeCommandRun(completedBy: "osc133" | "pty-exit", exitCode: number | null): void {
    const finalized = this.commandRuns.finalizeActive({
      completedBy,
      exitCode,
      endMarker: this.registerMarkerOrNull(),
      endedAt: this.currentWriteReplay ? null : Date.now(),
    });
    if (!finalized || this.currentWriteReplay) return;
    this.detectAndStoreProblems(finalized);
    this.notifyCommandRunFinalized(finalized);
    this.perceptionRef.current?.onCommandBlock({
      command: finalized.command,
      exitCode: finalized.exitCode,
      durationMs: finalized.durationMs,
      sessionId: this.sessionId,
    });
  }

  private notifyCommandRunFinalized(finalized: TerminalCommandRun): void {
    for (const listener of Array.from(this.commandRunFinalizedListeners)) {
      listener(finalized);
    }
  }

  private finalizeCommandRunForSessionDispose(): void {
    const finalized = this.commandRuns.finalizeForSessionDispose(
      Date.now(),
      this.registerMarkerOrNull(),
    );
    if (!finalized) return;
    this.notifyCommandRunFinalized(finalized);
  }

  private registerMarkerOrNull(): ReturnType<XTerm["registerMarker"]> | null {
    try {
      return this.term.registerMarker(0);
    } catch {
      return null;
    }
  }

  private clearCommandRunDecorations(): void {
    this.closeCommandRunMenu();
    this.setHoveredCommandRun(null);
    this.commandRunProblems.clear();
  }

  /** buffer の絶対行 line がどの command run の範囲内かを返す（無ければ null）。 */
  private commandRunAtLine(line: number): TerminalCommandRun | null {
    for (const run of this.commandRuns.getRecent()) {
      const start = run.startMarker?.line ?? -1;
      if (start < 0) continue;
      const end = run.endMarker?.line ?? start;
      if (line >= start && line <= end) return run;
    }
    return null;
  }

  /** hover 中の command run を更新し、その行範囲を region canvas に淡くハイライトする。 */
  private setHoveredCommandRun(run: TerminalCommandRun | null): void {
    const id = run?.id ?? null;
    if (id === this.hoveredCommandRunId) return;
    this.hoveredCommandRunId = id;
    this.drawCommandRunHighlight(run);
  }

  /** command block 全体の行範囲を viewport row に変換し region canvas に矩形を描く。 */
  private drawCommandRunHighlight(run: TerminalCommandRun | null): void {
    if (!run || this.regionDrag) {
      this.clearRegionCanvasNow();
      return;
    }
    const start = run.startMarker?.line ?? -1;
    if (start < 0) {
      this.clearRegionCanvasNow();
      return;
    }
    const end = run.endMarker?.line ?? start;
    const viewportY = this.term.buffer.active.viewportY;
    const rows = this.term.rows;
    const startRow = Math.max(0, start - viewportY);
    const endRow = Math.min(rows - 1, end - viewportY);
    if (endRow < startRow) {
      this.clearRegionCanvasNow();
      return;
    }
    const rect = this.xtermContainer.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const cellHeight = rect.height / rows;
    const top = startRow * cellHeight;
    const bottom = (endRow + 1) * cellHeight;
    const polygon: ReadonlyArray<RegionPoint> = [
      { x: 0, y: top },
      { x: rect.width, y: top },
      { x: rect.width, y: bottom },
      { x: 0, y: bottom },
    ];
    this.drawRegionHighlight(polygon);
  }

  /**
   * badge click で開く attach verb menu。run 由来の 2 verb（この出力 / 直近の失敗）を出す。
   * 範囲選択の attach は既存 Option+Shift+drag が担うので menu には含めない。
   * PTY へは書かず、選んだ verb は既存 reference 経路に乗せる。
   */
  /** クリック位置の buffer 行を返す（viewport 外なら null）。 */
  private lineFromClientY(clientY: number): number | null {
    const rect = this.xtermContainer.getBoundingClientRect();
    if (rect.height === 0) return null;
    const row = Math.floor((clientY - rect.top) / (rect.height / this.term.rows));
    if (row < 0 || row >= this.term.rows) return null;
    return this.term.buffer.active.viewportY + row;
  }

  /** 通常クリックが command block 上なら attach menu を開く（Cmd+click は別経路）。 */
  private handleCommandRunClick(event: MouseEvent): void {
    if (this.disposed) return;
    if (event.metaKey || event.altKey || event.shiftKey || event.button !== 0) return;
    const line = this.lineFromClientY(event.clientY);
    if (line === null) return;
    const run = this.commandRunAtLine(line);
    if (!run) return;
    event.preventDefault();
    event.stopPropagation();
    this.openCommandRunMenu(run, {
      top: event.clientY,
      bottom: event.clientY,
      left: event.clientX,
    });
  }

  /** pointermove で command block を hover 検出しハイライトする（drag 中は無視）。 */
  private handleCommandRunHover(event: MouseEvent): void {
    if (this.disposed || this.regionDrag) return;
    const line = this.lineFromClientY(event.clientY);
    // 同じ行の move では reflow（getBoundingClientRect）と run 走査を避ける。
    if (line === this.hoverProbeLine) return;
    this.hoverProbeLine = line;
    this.setHoveredCommandRun(line === null ? null : this.commandRunAtLine(line));
  }

  setCommandRunMenuTargets(
    targets: ReadonlyArray<{ readonly sessionId: string; readonly label: string }>,
  ): void {
    this.commandRunMenuTargets = targets;
  }

  /**
   * run の出力テキストを別 session の入力欄へ user gesture として書き込む。
   * 人間が menu で送信先を選んだ操作の代行であって、住人 AI による PTY write ではない
   * （observation-only は維持）。改行は実行を誘発しないよう空白に畳む。
   */
  private sendCommandRunToSession(run: TerminalCommandRun, targetSessionId: string): boolean {
    const context = this.buildCommandRunContext(run);
    if (!context || context.text === "") return false;
    const oneLine = context.text.replace(/\r?\n/g, " ").trim();
    if (oneLine === "") return false;
    // 送信先の入力欄が巨大な 1 行で埋まらないよう上限で切る。
    const payload = oneLine.length > 2000 ? `${oneLine.slice(0, 2000)}…` : oneLine;
    void sessionWrite({ sessionId: targetSessionId, data: payload }).catch(() => {});
    return true;
  }

  private openCommandRunMenu(
    run: TerminalCommandRun,
    anchorRect: { readonly top: number; readonly bottom: number; readonly left: number },
  ): void {
    this.closeCommandRunMenu();
    const menu = document.createElement("div");
    menu.className = "command-run-menu";
    menu.style.position = "fixed";
    // 位置は append 後に実寸を測ってから決める（flip 判定に menu の高さが要る）。
    menu.style.visibility = "hidden";

    const items: ReadonlyArray<{
      readonly attach: string;
      readonly label: string;
      readonly run: () => boolean;
    }> = [
      {
        attach: "this-output",
        label: "この出力を添付",
        run: () => this.attachCommandRunOutput(run.id),
      },
      {
        attach: "last-failed",
        label: "直近の失敗を添付",
        run: () => this.attachLastFailedRun(),
      },
      ...this.commandRunMenuTargets.map((target) => ({
        attach: `send:${target.sessionId}`,
        label: `${target.label} に送る`,
        run: () => this.sendCommandRunToSession(run, target.sessionId),
      })),
    ];
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "command-run-menu__item";
      button.dataset.attach = item.attach;
      button.textContent = item.label;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        item.run();
        this.closeCommandRunMenu();
      });
      menu.appendChild(button);
    }
    document.body.appendChild(menu);
    this.commandRunMenu = menu;

    // badge の画面位置に応じて menu を上下 flip + 横を画面内に clamp する。
    // terminal が最下部にあっても menu が viewport 外に出ないようにする。
    const menuRect = menu.getBoundingClientRect();
    const pos = resolveCommandRunMenuPosition(
      anchorRect,
      { width: menuRect.width, height: menuRect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    menu.style.top = `${pos.top}px`;
    menu.style.left = `${pos.left}px`;
    menu.style.visibility = "visible";

    const dismiss = (event: Event) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") this.closeCommandRunMenu();
        return;
      }
      if (this.commandRunMenu && !this.commandRunMenu.contains(event.target as Node)) {
        this.closeCommandRunMenu();
      }
    };
    document.addEventListener("mousedown", dismiss, { capture: true });
    document.addEventListener("keydown", dismiss, { capture: true });
    this.commandRunMenuDismiss = dismiss;
  }

  private closeCommandRunMenu(): void {
    if (this.commandRunMenuDismiss) {
      document.removeEventListener("mousedown", this.commandRunMenuDismiss, { capture: true });
      document.removeEventListener("keydown", this.commandRunMenuDismiss, { capture: true });
      this.commandRunMenuDismiss = null;
    }
    if (this.commandRunMenu) {
      this.commandRunMenu.remove();
      this.commandRunMenu = null;
    }
  }

  private captureCommandRunContext(run: TerminalCommandRun): boolean {
    const context = this.buildCommandRunContext(run);
    if (!context) return false;
    this.latestRegionContext = context;
    this.addTerminalReference(context);
    if (context.polygon.length > 0) {
      this.drawRegionHighlight(context.polygon);
      this.scheduleRegionCanvasClear();
    }
    for (const listener of Array.from(this.regionContextListeners)) {
      listener(context);
    }
    return true;
  }

  private buildCommandRunContext(run: TerminalCommandRun): TerminalRegionContext | null {
    const locus = this.buildCommandRunLocus(run);
    if (!locus) return null;

    const startLine = run.startMarker?.line ?? -1;
    const endLine = run.endMarker?.line ?? -1;
    const buffer = this.term.buffer.active;
    if (!buffer) return null;

    const firstLine = Math.min(startLine, endLine);
    const lastLine = Math.max(startLine, endLine);
    const lines: string[] = [];
    for (let lineIndex = firstLine; lineIndex <= lastLine; lineIndex++) {
      const line = buffer.getLine(lineIndex);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }
    const text = lines.join("\n").trim();
    if (text === "") return null;

    return {
      kind: "terminal-region-context",
      sessionId: this.sessionId,
      text,
      capturedAt: Date.now(),
      gesture: "command-run-click",
      commandRunId: run.id,
      viewport: locus.viewport,
      range: locus.range,
      rect: locus.rect,
      polygon: locus.polygon.map((point) => ({ ...point })),
    };
  }

  private buildCommandRunLocus(run: TerminalCommandRun): TerminalCommandRunLocus | null {
    const buffer = this.term.buffer.active;
    if (!buffer) return null;
    const startLine = run.startMarker?.line ?? -1;
    const currentLine = buffer.baseY + buffer.cursorY;
    const endLine = run.endMarker?.line ?? (run.status === "running" ? currentLine : -1);
    if (startLine < 0 || endLine < 0) return null;

    const firstLine = Math.min(startLine, endLine);
    const lastLine = Math.max(startLine, endLine);
    const rect = this.xtermContainer.getBoundingClientRect();
    const cellHeight = this.term.rows > 0 ? rect.height / this.term.rows : 0;
    const viewportStart = buffer.viewportY;
    const viewportEnd = viewportStart + Math.max(0, this.term.rows - 1);
    if (lastLine < viewportStart || firstLine > viewportEnd) return null;
    const visibleStartRow = clamp(firstLine - viewportStart, 0, Math.max(0, this.term.rows - 1));
    const visibleEndRow = clamp(lastLine - viewportStart, 0, Math.max(0, this.term.rows - 1));
    const top = Math.min(visibleStartRow, visibleEndRow) * cellHeight;
    const bottom = (Math.max(visibleStartRow, visibleEndRow) + 1) * cellHeight;
    const polygon: ReadonlyArray<RegionPoint> =
      rect.width > 0 && bottom > top
        ? [
            { x: 0, y: top },
            { x: rect.width, y: top },
            { x: rect.width, y: bottom },
            { x: 0, y: bottom },
          ]
        : [];

    return {
      kind: "terminal-command-run-locus",
      sessionId: this.sessionId,
      commandRunId: run.id,
      viewport: {
        viewportY: buffer.viewportY,
        rows: this.term.rows,
        cols: this.term.cols,
      },
      range: {
        startRow: visibleStartRow,
        endRow: visibleEndRow,
        startCol: 0,
        endCol: Math.max(0, this.term.cols - 1),
      },
      rect: {
        x: rect.left,
        y: rect.top + top,
        width: rect.width,
        height: Math.max(0, bottom - top),
      },
      polygon: polygon.map((point) => ({ ...point })),
    };
  }

  private readonly handleViewportResize = (): void => {
    this.syncAttachedRect();
  };

  private readonly handleActivationEvent = (): void => {
    if (this.disposed) return;
    for (const listener of Array.from(this.activationListeners)) {
      listener();
    }
  };

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

  private syncAttachedRect(): void {
    const container = this.attachedContainer;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const cs = getComputedStyle(container);
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padRight = parseFloat(cs.paddingRight) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const w = Math.max(0, Math.floor(rect.width - padLeft - padRight));
    const h = Math.max(0, Math.floor(rect.height - padTop - padBottom));
    this.xtermContainer.style.top = `${rect.top + padTop}px`;
    this.xtermContainer.style.left = `${rect.left + padLeft}px`;
    this.xtermContainer.style.width = `${w}px`;
    this.xtermContainer.style.height = `${h}px`;
    this.resizeRegionCanvas(w, h);
    this.xtermContainer.style.visibility = this.hidden ? "hidden" : "visible";
    // opacity は per-frame で触らないのが既定だが、layout で <1 が宣言されている
    // ときだけフラグから再適用して attach 経路の取りこぼしを防ぐ（既定 1 では
    // inline style を一切付けず「素の不透明」を保つ）。
    if (this.opacity !== 1) this.xtermContainer.style.opacity = String(this.opacity);
    if (w > 0 && h > 0 && (w !== this.lastFitW || h !== this.lastFitH)) {
      this.lastFitW = w;
      this.lastFitH = h;
      this.fitAddon.fit();
    }
    this.setHoveredCommandRun(null);
  }

  private createRegionCanvas(): {
    readonly canvas: HTMLCanvasElement;
    readonly context: CanvasRenderingContext2D;
  } | null {
    const canvas = document.createElement("canvas");
    canvas.className = "terminal-region-selection-canvas";
    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.pointerEvents = "none";
    canvas.style.zIndex = "5";
    canvas.setAttribute("aria-hidden", "true");
    this.xtermContainer.appendChild(canvas);

    const context = canvas.getContext("2d");
    if (!context) {
      canvas.remove();
      return null;
    }
    return { canvas, context };
  }

  private handleMetaClick(event: MouseEvent): void {
    if (this.disposed) return;
    if (!event.metaKey || event.altKey || event.shiftKey || event.button !== 0) return;

    const buffer = this.term.buffer.active;
    if (!buffer) return;

    const containerRect = this.xtermContainer.getBoundingClientRect();
    if (containerRect.width === 0 || containerRect.height === 0) return;

    const cellWidth = containerRect.width / this.term.cols;
    const cellHeight = containerRect.height / this.term.rows;
    const row = Math.floor((event.clientY - containerRect.top) / cellHeight);
    if (row < 0 || row >= this.term.rows) return;

    const line = buffer.getLine(buffer.viewportY + row);
    if (!line) return;

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
    if (startCol === -1 || endCol === -1) return;

    const text = line.translateToString(true).trim();
    if (text === "") return;

    event.preventDefault();
    event.stopPropagation();

    const lineRect = {
      x: containerRect.left + startCol * cellWidth,
      y: containerRect.top + row * cellHeight,
      width: (endCol - startCol + 1) * cellWidth,
      height: cellHeight,
    };

    const polygon: ReadonlyArray<RegionPoint> = [
      { x: startCol * cellWidth, y: row * cellHeight },
      { x: (endCol + 1) * cellWidth, y: row * cellHeight },
      { x: (endCol + 1) * cellWidth, y: (row + 1) * cellHeight },
      { x: startCol * cellWidth, y: (row + 1) * cellHeight },
    ];

    const context: TerminalRegionContext = {
      kind: "terminal-region-context",
      sessionId: this.sessionId,
      text,
      capturedAt: Date.now(),
      gesture: "meta-click",
      viewport: {
        viewportY: buffer.viewportY,
        rows: this.term.rows,
        cols: this.term.cols,
      },
      range: {
        startRow: row,
        endRow: row,
        startCol,
        endCol,
      },
      rect: lineRect,
      polygon: polygon.map((p) => ({ ...p })),
    };

    this.latestRegionContext = context;
    this.addTerminalReference(context);

    this.drawRegionHighlight(polygon);
    this.scheduleRegionCanvasClear();

    for (const listener of Array.from(this.regionContextListeners)) {
      listener(context);
    }
  }

  private installRegionSelectionHandlers(): void {
    this.xtermContainer.addEventListener(
      "click",
      (event) => {
        // 通常クリックは command block → attach menu、Cmd+click は 1 行 region context。
        this.handleCommandRunClick(event);
        this.handleMetaClick(event);
      },
      { capture: true },
    );
    // command block の hover ハイライト（drag 用 pointermove とは別、capture なし）。
    this.xtermContainer.addEventListener("pointermove", (event) =>
      this.handleCommandRunHover(event),
    );
    this.xtermContainer.addEventListener("pointerleave", () => this.setHoveredCommandRun(null));

    this.xtermContainer.addEventListener(
      "pointerdown",
      (event) => {
        if (this.disposed) return;
        if (!event.altKey || !event.shiftKey || event.button !== 0) return;
        const point = this.regionPointFromEvent(event);
        if (!point) return;

        event.preventDefault();
        event.stopPropagation();
        this.regionDrag = {
          pointerId: event.pointerId,
          start: point,
          current: point,
        };
        this.xtermContainer.setPointerCapture(event.pointerId);
        this.clearRegionCanvasNow();
        this.drawRegionRectangle(this.regionDrag.start, this.regionDrag.current, false);
      },
      { capture: true },
    );

    this.xtermContainer.addEventListener(
      "pointermove",
      (event) => {
        const drag = this.regionDrag;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const point = this.regionPointFromEvent(event);
        if (!point) return;

        event.preventDefault();
        event.stopPropagation();
        const dx = point.x - drag.current.x;
        const dy = point.y - drag.current.y;
        if (dx * dx + dy * dy >= 9) {
          drag.current = point;
          this.drawRegionRectangle(drag.start, drag.current, false);
        }
      },
      { capture: true },
    );

    this.xtermContainer.addEventListener(
      "pointerup",
      (event) => {
        if (!this.regionDrag || this.regionDrag.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        this.finishRegionDrag();
      },
      { capture: true },
    );

    this.xtermContainer.addEventListener(
      "pointercancel",
      (event) => {
        if (!this.regionDrag || this.regionDrag.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        this.regionDrag = null;
        this.scheduleRegionCanvasClear();
      },
      { capture: true },
    );
  }

  private regionPointFromEvent(event: PointerEvent): RegionPoint | null {
    const rect = this.xtermContainer.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
    };
  }

  private addTerminalReference(context: TerminalRegionContext): string {
    this.terminalReferenceCounter++;
    const localId = `Term${this.terminalReferenceCounter}`;
    const id = `${this.sessionId}:${localId}`;
    this.terminalReferences.set(id, { id, context });
    const marker = `[#${localId}] `;
    void sessionWrite({ sessionId: this.sessionId, data: marker }).catch(() => {});
    return id;
  }

  private finishRegionDrag(): void {
    const drag = this.regionDrag;
    this.regionDrag = null;
    if (!drag) {
      this.scheduleRegionCanvasClear();
      return;
    }

    const polygon = rectanglePolygon(drag.start, drag.current);
    const bounds = polygonBounds(polygon);
    if (!bounds || bounds.width === 0 || bounds.height === 0) {
      this.scheduleRegionCanvasClear();
      return;
    }

    this.drawRegionRectangle(drag.start, drag.current, true);
    const context = this.extractRegionContext(polygon);
    if (!context) {
      this.scheduleRegionCanvasClear();
      return;
    }
    this.latestRegionContext = context;
    this.addTerminalReference(context);
    for (const listener of Array.from(this.regionContextListeners)) {
      listener(context);
    }
    this.scheduleRegionCanvasClear();
  }

  private extractRegionContext(polygon: ReadonlyArray<RegionPoint>): TerminalRegionContext | null {
    const buffer = this.term.buffer.active;
    if (!buffer) return null;

    const rect = this.xtermContainer.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    const cellWidth = rect.width / this.term.cols;
    const cellHeight = rect.height / this.term.rows;
    const extracted = extractRegionText({
      rows: this.term.rows,
      cols: this.term.cols,
      cellWidth,
      cellHeight,
      polygon,
      getCell: (row, col) => {
        const line = buffer.getLine(buffer.viewportY + row);
        const cell = line?.getCell(col);
        return cell?.getChars() || " ";
      },
    });
    if (!extracted || extracted.text === "") return null;

    const bounds = polygonBounds(polygon);
    if (!bounds) return null;

    return {
      kind: "terminal-region-context",
      sessionId: this.sessionId,
      text: extracted.text,
      capturedAt: Date.now(),
      gesture: "option-shift-drag",
      viewport: {
        viewportY: buffer.viewportY,
        rows: this.term.rows,
        cols: this.term.cols,
      },
      range: {
        startRow: extracted.startRow,
        endRow: extracted.endRow,
        startCol: extracted.startCol,
        endCol: extracted.endCol,
      },
      rect: {
        x: rect.left + bounds.x,
        y: rect.top + bounds.y,
        width: bounds.width,
        height: bounds.height,
      },
      polygon: polygon.map((point) => ({ ...point })),
    };
  }

  private resizeRegionCanvas(width: number, height: number): void {
    if (!this.regionCanvas || !this.regionCtx) return;
    const dpr = window.devicePixelRatio || 1;
    const nextWidth = Math.max(1, Math.floor(width * dpr));
    const nextHeight = Math.max(1, Math.floor(height * dpr));
    if (this.regionCanvas.width === nextWidth && this.regionCanvas.height === nextHeight) return;
    this.regionCanvas.width = nextWidth;
    this.regionCanvas.height = nextHeight;
    this.regionCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private drawRegionPolygon(polygon: ReadonlyArray<RegionPoint>, closed: boolean): void {
    if (!this.regionCtx) return;
    this.clearRegionCanvasNow();
    if (polygon.length === 0) return;

    const ctx = this.regionCtx;
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(77, 217, 207, 0.95)";
    ctx.fillStyle = "rgba(77, 217, 207, 0.14)";
    ctx.shadowColor = "rgba(77, 217, 207, 0.6)";
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(polygon[0].x, polygon[0].y);
    for (const point of polygon.slice(1)) {
      ctx.lineTo(point.x, point.y);
    }
    ctx.closePath();
    if (closed) {
      ctx.fill();
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Command+click 用: 囲み線なしの fill のみハイライト。 */
  private drawRegionHighlight(polygon: ReadonlyArray<RegionPoint>): void {
    if (!this.regionCtx) return;
    this.clearRegionCanvasNow();
    if (polygon.length === 0) return;

    const ctx = this.regionCtx;
    ctx.save();
    ctx.fillStyle = "rgba(77, 217, 207, 0.22)";
    ctx.beginPath();
    ctx.moveTo(polygon[0].x, polygon[0].y);
    for (const point of polygon.slice(1)) {
      ctx.lineTo(point.x, point.y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private clearRegionCanvasNow(): void {
    if (!this.regionCtx) return;
    this.clearImePendingCommitTimer();
    if (this.clearRegionCanvasTimeout !== null) {
      window.clearTimeout(this.clearRegionCanvasTimeout);
      this.clearRegionCanvasTimeout = null;
    }
    const rect = this.xtermContainer.getBoundingClientRect();
    this.regionCtx.clearRect(0, 0, rect.width, rect.height);
  }

  private scheduleRegionCanvasClear(): void {
    this.clearImePendingCommitTimer();
    if (this.clearRegionCanvasTimeout !== null) {
      window.clearTimeout(this.clearRegionCanvasTimeout);
    }
    this.clearRegionCanvasTimeout = window.setTimeout(() => {
      this.clearRegionCanvasTimeout = null;
      this.clearRegionCanvasNow();
    }, 900);
  }

  private drawRegionRectangle(start: RegionPoint, current: RegionPoint, filled: boolean): void {
    this.drawRegionPolygon(rectanglePolygon(start, current), filled);
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
      (a.systemPrompt ?? null) === (b.systemPrompt ?? null) &&
      (a.pluginDir ?? null) === (b.pluginDir ?? null)
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

function parseOsc133ExitCode(data: string): number | null {
  if (data === "D") return null;
  const raw = data.slice(2);
  if (raw === "") return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

function normalizePtyExitCode(code: number): number | null {
  return code >= 0 ? code : null;
}

function parseOsc633Cwd(data: string): string | null {
  for (const part of data.split(";")) {
    if (part.startsWith("Cwd=")) {
      return decodeOsc633Value(part.slice("Cwd=".length));
    }
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function rectanglePolygon(start: RegionPoint, current: RegionPoint): ReadonlyArray<RegionPoint> {
  const left = Math.min(start.x, current.x);
  const right = Math.max(start.x, current.x);
  const top = Math.min(start.y, current.y);
  const bottom = Math.max(start.y, current.y);
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
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

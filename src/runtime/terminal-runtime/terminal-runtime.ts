import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm } from "@xterm/xterm";
import { ptyResize, ptySpawn, ptyWrite } from "../../bindings/tauri-commands";
import type { Perception } from "../../core/perception";
import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import type { PtyParams, TerminalRuntime } from "./types";

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
  private readonly term: XTerm;
  private readonly fitAddon: FitAddon;
  private readonly xtermContainer: HTMLDivElement;
  private readonly channel: Channel<ArrayBuffer>;
  private readonly perceptionRef: { current: Perception | null } = { current: null };
  private readonly textDecoder = new TextDecoder("utf-8", { fatal: false });

  private currentParams: PtyParams | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    this.term = new XTerm({
      theme: {
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
      },
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
      const text = this.textDecoder.decode(bytes, { stream: true });
      this.perceptionRef.current?.onPtyOutput(text);
    };

    // PTY exit listener（claude が終了したら terminal に表示）
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      await listen<{ code: number }>("pty-exit", (event) => {
        this.term.write(`\r\n\x1b[90m[Process exited with code ${event.payload.code}]\x1b[0m\r\n`);
      });
    })();

    // ユーザー入力を PTY に流す
    let writeQueue: Promise<void> = Promise.resolve();
    this.term.onData((data) => {
      this.perceptionRef.current?.onUserInput(data);
      writeQueue = writeQueue.then(async () => {
        try {
          await ptyWrite({ data });
        } catch {
          // PTY already closed — silent
        }
      });
    });

    // xterm 側の cols/rows 変化を Rust に転送
    this.term.onResize(({ cols, rows }) => {
      void ptyResize({ cols, rows });
    });
  }

  attachTo(container: HTMLElement): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    const syncRect = () => {
      const rect = container.getBoundingClientRect();
      this.xtermContainer.style.top = `${rect.top}px`;
      this.xtermContainer.style.left = `${rect.left}px`;
      this.xtermContainer.style.width = `${rect.width}px`;
      this.xtermContainer.style.height = `${rect.height}px`;
      this.xtermContainer.style.visibility = "visible";
      requestAnimationFrame(() => this.fitAddon.fit());
    };

    syncRect();

    this.resizeObserver = new ResizeObserver(syncRect);
    this.resizeObserver.observe(container);
  }

  detachContainer(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.xtermContainer.style.visibility = "hidden";
  }

  updatePtyParams(params: PtyParams): void {
    if (this.paramsEqual(this.currentParams, params)) {
      return;
    }
    this.currentParams = params;

    void (async () => {
      try {
        await ptySpawn({
          cols: this.term.cols,
          rows: this.term.rows,
          cwd: params.cwd,
          systemPrompt: params.systemPrompt,
          onOutput: this.channel,
        });
      } catch (err) {
        this.term.write(`\x1b[31mFailed to start claude: ${err}\x1b[0m\r\n`);
        this.term.write("\x1b[90mMake sure claude CLI is installed and in your PATH.\x1b[0m\r\n");
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

  private paramsEqual(a: PtyParams | null, b: PtyParams): boolean {
    if (a === null) return false;
    return a.cwd === b.cwd && a.systemPrompt === b.systemPrompt;
  }
}

export function getTerminalRuntime(): TerminalRuntime {
  return getOrInit(KEYS.TERMINAL_RUNTIME, () => new TerminalRuntimeImpl());
}

// Self-accept: terminal-runtime.ts 自身を編集しても singleton は保たれる。
// React 側（terminal.tsx）は影響なく次 mount で同 instance を引く。
if (import.meta.hot) {
  import.meta.hot.accept();
}

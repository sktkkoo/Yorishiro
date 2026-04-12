import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import type { Perception } from "./core/perception";

interface TerminalProps {
  readonly cwd: string | null;
  readonly systemPrompt: string | null;
  readonly perception: Perception | null;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export default function Terminal({ cwd, systemPrompt, perception }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ptyDeps, setPtyDeps] = useState<{
    term: XTerm;
    fitAddon: FitAddon;
    container: HTMLDivElement;
  } | null>(null);

  // ── xterm.js initialization (pure UI) ─────────────────────────

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let alive = true;

    const term = new XTerm({
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

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);

    const disposables: (() => void)[] = [];

    let currentWebgl: WebglAddon | null = null;
    function loadWebgl() {
      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          webglAddon.dispose();
          currentWebgl = null;
          setTimeout(() => {
            if (alive) loadWebgl();
          }, 1000);
        });
        term.loadAddon(webglAddon);
        currentWebgl = webglAddon;
      } catch {
        // Canvas renderer remains active as fallback
      }
    }
    disposables.push(() => {
      currentWebgl?.dispose();
      currentWebgl = null;
    });

    requestAnimationFrame(() => {
      if (!alive) return;
      fitAddon.fit();
      loadWebgl();

      setPtyDeps({ term, fitAddon, container });

      if (!isTauri) {
        term.write("Tauri runtime not found.\r\n");
        term.write("Run with: npm run tauri dev\r\n");
      }
    });

    return () => {
      alive = false;
      for (const d of disposables) d();
      setPtyDeps(null);
      term.dispose();
    };
  }, []);

  // ── PTY lifecycle ─────────────────────────────────────────────

  useEffect(() => {
    if (!isTauri) return;
    if (!ptyDeps) return;

    const { term, fitAddon, container } = ptyDeps;
    let alive = true;
    const disposables: (() => void)[] = [];

    const textDecoder = new TextDecoder("utf-8", { fatal: false });
    const perceptionRef = perception;

    (async () => {
      const { invoke, Channel } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");

      // StrictMode guard: if cleanup already ran while we awaited imports,
      // bail out WITHOUT killing the PTY — a second render will attach to it.
      if (!alive) return;

      // Channel for PTY output (raw binary)
      const onOutput = new Channel<ArrayBuffer>();
      onOutput.onmessage = (data: ArrayBuffer) => {
        if (!alive) return;
        const bytes = new Uint8Array(data);
        term.write(bytes);
        const text = textDecoder.decode(bytes, { stream: true });
        perceptionRef?.onPtyOutput(text);
      };

      // NOTE: hook-signal listener is in App.tsx (global, survives hot-reload)

      // PTY exit listener
      const unlistenExit = await listen<{ code: number }>("pty-exit", (event) => {
        term.write(`\r\n\x1b[90m[Process exited with code ${event.payload.code}]\x1b[0m\r\n`);
      });
      disposables.push(unlistenExit);

      // Spawn PTY — pty_spawn internally kills any existing session first

      try {
        await invoke("pty_spawn", {
          cols: term.cols,
          rows: term.rows,
          cwd,
          systemPrompt,
          onOutput,
        });
      } catch (err) {
        term.write(`\x1b[31mFailed to start claude: ${err}\x1b[0m\r\n`);
        term.write("\x1b[90mMake sure claude CLI is installed and in your PATH.\x1b[0m\r\n");
        return;
      }

      if (!alive) return;

      // Forward input to PTY
      let writeQueue: Promise<void> = Promise.resolve();
      const onDataDisposable = term.onData((data) => {
        perceptionRef?.onUserInput(data);
        writeQueue = writeQueue.then(async () => {
          try {
            await invoke("pty_write", { data });
          } catch {
            // PTY already closed
          }
        });
      });
      disposables.push(() => onDataDisposable.dispose());

      // Handle resize
      const onResizeDisposable = term.onResize(({ cols, rows }) => {
        invoke("pty_resize", { cols, rows });
      });
      disposables.push(() => onResizeDisposable.dispose());

      // Deferred fit: coalesce rapid resize events
      let fitPending = false;
      const resizeObserver = new ResizeObserver(() => {
        if (!alive || fitPending) return;
        fitPending = true;
        requestAnimationFrame(() => {
          fitPending = false;
          if (alive) fitAddon.fit();
        });
      });
      resizeObserver.observe(container);
      disposables.push(() => resizeObserver.disconnect());
    })();

    return () => {
      // Clean up JS-side only. Do NOT kill or detach the PTY here —
      // StrictMode's double-render would race with the second mount's
      // pty_attach/pty_spawn. The PTY survives across re-mounts;
      // the next mount's pty_attach atomically swaps the channel.

      alive = false;
      for (const d of disposables) d();
    };
  }, [ptyDeps, cwd, systemPrompt, perception]);

  return <div ref={containerRef} className="terminal-container" />;
}

import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import type { Perception } from "./core/perception";

interface TerminalProps {
  readonly cwd: string | null;
  readonly perception: Perception | null;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export default function Terminal({ cwd, perception }: TerminalProps) {
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
      if (!alive) return;

      const { invoke, Channel } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");

      if (!alive) {
        invoke("pty_kill");
        return;
      }

      // Channel for PTY output (raw binary)
      const onOutput = new Channel<ArrayBuffer>();
      onOutput.onmessage = (data: ArrayBuffer) => {
        const bytes = new Uint8Array(data);
        term.write(bytes);
        const text = textDecoder.decode(bytes, { stream: true });
        perceptionRef?.onPtyOutput(text);
      };

      // Hook signal listener
      const unlistenHook = await listen<string>("hook-signal", (event) => {
        perceptionRef?.onHookSignal(event.payload);
      });
      disposables.push(unlistenHook);

      // PTY exit listener
      const unlistenExit = await listen<{ code: number }>("pty-exit", (event) => {
        term.write(`\r\n\x1b[90m[Process exited with code ${event.payload.code}]\x1b[0m\r\n`);
      });
      disposables.push(unlistenExit);

      // Try attach first (WebView HMR), then spawn
      let attached = false;
      try {
        attached = await invoke<boolean>("pty_attach", {
          cwd,
          onOutput,
        });
      } catch {
        // pty_attach not available or failed
      }

      if (!attached) {
        try {
          await invoke("pty_spawn", {
            cols: term.cols,
            rows: term.rows,
            cwd,
            onOutput,
          });
        } catch (err) {
          term.write(`\x1b[31mFailed to start claude: ${err}\x1b[0m\r\n`);
          term.write("\x1b[90mMake sure claude CLI is installed and in your PATH.\x1b[0m\r\n");
          return;
        }
      }

      if (!alive) {
        invoke("pty_kill");
        return;
      }

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
      alive = false;
      for (const d of disposables) d();
      // Detach (not kill) on unmount — PTY survives HMR
      import("@tauri-apps/api/core").then(({ invoke }) => invoke("pty_detach"));
    };
  }, [ptyDeps, cwd, perception]);

  return <div ref={containerRef} className="terminal-container" />;
}

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRecording } from "./types";

const mockState = vi.hoisted(() => {
  const state: {
    terminals: Array<{
      writes: unknown[];
      resizes: Array<{ cols: number; rows: number }>;
      resetCalls: number;
      disposed: boolean;
      options: { theme?: Record<string, string> };
    }>;
    onDataCalls: number;
  } = {
    terminals: [],
    onDataCalls: 0,
  };
  return state;
});

const themeState = vi.hoisted(() => ({
  current: { background: "#111111" } as Record<string, string>,
}));

// live terminal と同じテーマ供給源を読む契約をテストするため、供給源を差し替える。
vi.mock("../terminal-theme", () => ({
  getCurrentTerminalTheme: () => ({ ...themeState.current }),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    writes: unknown[] = [];
    resizes: Array<{ cols: number; rows: number }> = [];
    resetCalls = 0;
    disposed = false;
    options: { theme?: Record<string, string> };

    constructor(options: { theme?: Record<string, string> } = {}) {
      this.options = options;
      mockState.terminals.push(this);
    }

    open(container: HTMLElement): void {
      const xterm = document.createElement("div");
      xterm.className = "xterm";
      Object.defineProperty(xterm, "getBoundingClientRect", {
        value: () => ({ top: 0, left: 0, width: 800, height: 400 }),
      });
      container.appendChild(xterm);
    }
    reset(): void {
      this.resetCalls += 1;
      this.writes = [];
      this.resizes = [];
    }
    write(data: unknown): void {
      this.writes.push(data);
    }
    resize(cols: number, rows: number): void {
      this.resizes.push({ cols, rows });
    }
    dispose(): void {
      this.disposed = true;
    }
    onData(): void {
      mockState.onDataCalls += 1;
    }
  },
}));

const { createReplayTerminal } = await import("./replay-terminal");

const recording: SessionRecording = {
  id: "session-default-session-100-1",
  sessionId: "default-session",
  label: "codex",
  kind: "agent",
  origin: "lifecycle",
  startedAt: 100,
  endedAt: 400,
  status: "ended",
  entries: [
    { kind: "marker", marker: "session-start", label: "codex", timestamp: 100 },
    { kind: "resize", cols: 80, rows: 24, timestamp: 100 },
    { kind: "pty", text: "\x1b[32mhello\x1b[0m\n", timestamp: 120 },
    { kind: "resize", cols: 120, rows: 30, timestamp: 250 },
    { kind: "pty", text: "done\n", timestamp: 300 },
  ],
};

describe("ReplayTerminal", () => {
  beforeEach(() => {
    mockState.terminals.length = 0;
    mockState.onDataCalls = 0;
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not connect xterm input to PTY", () => {
    const replay = createReplayTerminal();

    expect(mockState.onDataCalls).toBe(0);

    replay.dispose();
  });

  it("scene 供給源の現在テーマで xterm を作り、attach 時に再適用する", () => {
    themeState.current = { background: "#123456" };
    const replay = createReplayTerminal();
    const terminal = mockState.terminals[0];

    expect(terminal.options.theme?.background).toBe("#123456");

    themeState.current = { background: "#654321" };
    const host = document.createElement("div");
    document.body.appendChild(host);
    replay.attachTo(host);

    expect(terminal.options.theme?.background).toBe("#654321");
    replay.dispose();
  });

  it("linear-seeks by applying recorded resize and PTY stream entries", () => {
    const replay = createReplayTerminal();
    const terminal = mockState.terminals[0];

    replay.loadStream(recording);
    replay.seekLinear(250);

    expect(terminal.resetCalls).toBe(2);
    expect(terminal.resizes).toEqual([
      { cols: 80, rows: 24 },
      { cols: 120, rows: 30 },
    ]);
    expect(terminal.writes).toEqual(["\x1b[32mhello\x1b[0m\n"]);

    replay.dispose();
  });

  it("notifies replay position subscribers on linear seek", () => {
    const replay = createReplayTerminal();
    const positions: number[] = [];

    replay.loadStream(recording);
    const sub = replay.onPosition((timestamp) => positions.push(timestamp));
    replay.seekLinear(250);
    replay.seekLinear(275);
    sub.dispose();
    replay.seekLinear(300);

    expect(positions).toEqual([250, 275]);

    replay.dispose();
  });

  it("appends live tail entries to the loaded stream", () => {
    const replay = createReplayTerminal();
    const terminal = mockState.terminals[0];

    replay.loadStream(recording, { maxGapMs: 400 });
    replay.appendEntries([
      { kind: "marker", marker: "intervention", label: "User intervention", timestamp: 320 },
      { kind: "pty", text: "tail\n", timestamp: 900 },
      { kind: "resize", cols: 100, rows: 28, timestamp: 910 },
    ]);
    replay.seekLinear(910);

    expect(terminal.writes).toEqual(["\x1b[32mhello\x1b[0m\n", "done\n", "tail\n"]);
    expect(terminal.resizes).toEqual([
      { cols: 80, rows: 24 },
      { cols: 120, rows: 30 },
      { cols: 100, rows: 28 },
    ]);

    replay.dispose();
  });

  it("attaches as a fixed replay container and mirrors terminal rect visibility", () => {
    const replay = createReplayTerminal();
    const host = document.createElement("div");
    Object.defineProperty(host, "getBoundingClientRect", {
      value: () => ({ top: 10, left: 20, width: 640, height: 360 }),
    });
    document.body.appendChild(host);

    replay.attachTo(host);
    replay.setHidden(false);

    const container = document.body.querySelector<HTMLElement>(".xterm-replay-container");
    expect(container?.style.position).toBe("fixed");
    expect(container?.style.visibility).toBe("visible");
    expect(container?.style.top).toBe("10px");
    expect(container?.style.left).toBe("20px");
    expect(container?.style.width).toBe("640px");
    expect(container?.style.height).toBe("360px");

    replay.dispose();
  });
});

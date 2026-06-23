// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Perception } from "../../core/perception";
import { _clearForTest } from "../hot-data/hot-data";
import { encodeOsc633Value } from "./osc633";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

interface MockBufferLine {
  translateToString(trimRight?: boolean): string;
  getCell(col: number): {
    getChars(): string;
    isFgDefault(): boolean;
    getFgColor(): number;
  };
}

interface MockBuffer {
  readonly active: {
    readonly baseY: number;
    readonly cursorY: number;
    // viewportY は block navigation の jump test で書き換えるので mutable。
    viewportY: number;
    getLine(lineIndex: number): MockBufferLine | undefined;
  };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mockState = vi.hoisted(() => {
  const state: {
    channels: Array<{ onmessage: ((data: ArrayBuffer) => void) | null }>;
    terminals: Array<{
      writes: unknown[];
      clearCalls: number;
      disposed: boolean;
      textarea: HTMLTextAreaElement;
      customKeyEventHandler?: (event: KeyboardEvent) => boolean;
    }>;
    decorations: Array<{ element: HTMLElement; dispose: ReturnType<typeof vi.fn> }>;
    oscHandlers: Map<number, (data: string) => boolean | Promise<boolean>>;
    eventListeners: Map<string, Array<(event: { payload: unknown }) => void>>;
    fitCalls: number;
    focusCalls: number;
    // block navigation の jump 先を検証するための scroll 呼び出しログ。
    scrollToLineCalls: number[];
    scrollLinesCalls: number[];
    unlisten: ReturnType<typeof vi.fn>;
    listen: ReturnType<typeof vi.fn>;
    sessionAttach: ReturnType<typeof vi.fn>;
    sessionDestroy: ReturnType<typeof vi.fn>;
    sessionRefreshTheme: ReturnType<typeof vi.fn>;
    sessionResize: ReturnType<typeof vi.fn>;
    sessionSpawn: ReturnType<typeof vi.fn>;
    sessionWrite: ReturnType<typeof vi.fn>;
  } = {
    channels: [],
    terminals: [],
    decorations: [],
    oscHandlers: new Map(),
    eventListeners: new Map(),
    fitCalls: 0,
    focusCalls: 0,
    scrollToLineCalls: [],
    scrollLinesCalls: [],
    unlisten: vi.fn(),
    listen: vi.fn(),
    sessionAttach: vi.fn(),
    sessionDestroy: vi.fn(),
    sessionRefreshTheme: vi.fn(),
    sessionResize: vi.fn(),
    sessionSpawn: vi.fn(),
    sessionWrite: vi.fn(),
  };
  state.listen.mockImplementation(
    (eventName: string, listener: (event: { payload: unknown }) => void) => {
      const listeners = state.eventListeners.get(eventName) ?? [];
      listeners.push(listener);
      state.eventListeners.set(eventName, listeners);
      return Promise.resolve(state.unlisten);
    },
  );
  return state;
});

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class MockChannel {
    onmessage: ((data: ArrayBuffer) => void) | null = null;

    constructor() {
      mockState.channels.push(this);
    }
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mockState.listen,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit(): void {
      mockState.fitCalls++;
    }
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    cols = 80;
    rows = 24;
    options: { theme?: unknown };
    writes: unknown[] = [];
    clearCalls = 0;
    disposed = false;
    textarea = document.createElement("textarea");
    customKeyEventHandler?: (event: KeyboardEvent) => boolean;
    buffer: MockBuffer;
    bufferLines = new Map<number, string>([
      [1, "$ npm test"],
      [2, "failed output"],
    ]);
    private markerId = 0;
    parser = {
      registerOscHandler: (
        ident: number,
        callback: (data: string) => boolean | Promise<boolean>,
      ) => {
        mockState.oscHandlers.set(ident, callback);
        return {
          dispose: () => {
            mockState.oscHandlers.delete(ident);
          },
        };
      },
    };

    constructor(options: { theme?: unknown }) {
      this.options = options;
      this.buffer = {
        active: {
          baseY: 0,
          cursorY: 2,
          viewportY: 0,
          getLine: (lineIndex: number) => {
            const text = this.bufferLines.get(lineIndex);
            if (text === undefined) return undefined;
            return {
              translateToString: () => text,
              getCell: (col: number) => {
                const char = text[col] ?? " ";
                return {
                  getChars: () => char,
                  isFgDefault: () => true,
                  getFgColor: () => 0,
                };
              },
            };
          },
        },
      };
      mockState.terminals.push(this);
    }

    loadAddon(): void {}
    open(): void {}
    reset(): void {
      this.writes = [];
    }
    write(data: unknown, callback?: () => void): void {
      this.writes.push(data);
      callback?.();
    }
    dispose(): void {
      this.disposed = true;
    }
    onData(): void {}
    onResize(): void {}
    onScroll(): void {}
    scrollToLine(line: number): void {
      mockState.scrollToLineCalls.push(line);
      this.buffer.active.viewportY = line;
    }
    scrollLines(amount: number): void {
      mockState.scrollLinesCalls.push(amount);
      this.buffer.active.viewportY += amount;
    }
    focus(): void {
      mockState.focusCalls++;
    }
    refresh(): void {}
    clear(): void {
      this.clearCalls++;
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
      this.customKeyEventHandler = handler;
    }
    registerMarker(): unknown {
      this.markerId++;
      return {
        id: this.markerId,
        line: this.markerId,
        isDisposed: false,
        onDispose: vi.fn(),
        dispose: vi.fn(),
      };
    }
    registerDecoration(): unknown {
      const element = document.createElement("button");
      const dispose = vi.fn();
      const decoration = {
        marker: null,
        element,
        isDisposed: false,
        onDispose: vi.fn(),
        options: {},
        dispose,
        onRender: (listener: (element: HTMLElement) => void) => {
          listener(element);
          return { dispose: vi.fn() };
        },
      };
      mockState.decorations.push({ element, dispose });
      return decoration;
    }
  },
}));

vi.mock("../../bindings/tauri-commands", () => ({
  sessionAttach: mockState.sessionAttach,
  sessionDestroy: mockState.sessionDestroy,
  sessionRefreshTheme: mockState.sessionRefreshTheme,
  sessionResize: mockState.sessionResize,
  sessionSpawn: mockState.sessionSpawn,
  sessionWrite: mockState.sessionWrite,
}));

const { disposeTerminalRuntime, getTerminalRuntime } = await import("./terminal-runtime");

const shellSpec = { kind: "shell" as const, integration: true };

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("TerminalRuntime", () => {
  beforeEach(() => {
    _clearForTest();
    // 前 test が body 直下に残した xterm singleton container（gutter badge を含む）を掃除。
    for (const el of document.querySelectorAll(".xterm-singleton-container")) {
      el.remove();
    }
    mockState.channels.length = 0;
    mockState.terminals.length = 0;
    mockState.decorations.length = 0;
    mockState.oscHandlers.clear();
    mockState.eventListeners.clear();
    mockState.fitCalls = 0;
    mockState.focusCalls = 0;
    mockState.scrollToLineCalls.length = 0;
    mockState.scrollLinesCalls.length = 0;
    mockState.unlisten.mockClear();
    mockState.listen.mockClear();
    mockState.listen.mockImplementation(
      (eventName: string, listener: (event: { payload: unknown }) => void) => {
        const listeners = mockState.eventListeners.get(eventName) ?? [];
        listeners.push(listener);
        mockState.eventListeners.set(eventName, listeners);
        return Promise.resolve(mockState.unlisten);
      },
    );
    mockState.sessionAttach.mockReset();
    mockState.sessionAttach.mockResolvedValue({ attached: false, replay: [] });
    mockState.sessionDestroy.mockReset();
    mockState.sessionDestroy.mockResolvedValue(undefined);
    mockState.sessionRefreshTheme.mockReset();
    mockState.sessionRefreshTheme.mockResolvedValue(undefined);
    mockState.sessionResize.mockReset();
    mockState.sessionResize.mockResolvedValue(undefined);
    mockState.sessionSpawn.mockReset();
    mockState.sessionSpawn.mockResolvedValue(undefined);
    mockState.sessionWrite.mockReset();
    mockState.sessionWrite.mockResolvedValue(undefined);
  });

  afterEach(() => {
    disposeTerminalRuntime("shell-1");
    _clearForTest();
  });

  it("aborts attach-first spawn while attach is still pending", async () => {
    const attach = deferred<{ attached: boolean; replay: number[] }>();
    mockState.sessionAttach.mockReturnValueOnce(attach.promise);
    const runtime = getTerminalRuntime("shell-1");

    runtime.updatePtyParams({ spec: shellSpec, cwd: null }, { attachFirst: true });
    await flushMicrotasks();
    expect(mockState.sessionAttach).toHaveBeenCalledOnce();

    disposeTerminalRuntime("shell-1");
    attach.resolve({ attached: false, replay: [] });
    await flushMicrotasks();

    expect(mockState.sessionSpawn).not.toHaveBeenCalled();
  });

  it("attach-first 成功後に PTY resize と theme refresh を送り TUI 再描画を促す", async () => {
    mockState.sessionAttach.mockResolvedValueOnce({ attached: true, replay: [] });
    const runtime = getTerminalRuntime("shell-1");

    runtime.updatePtyParams({ spec: shellSpec, cwd: null }, { attachFirst: true });
    await flushMicrotasks();

    expect(mockState.sessionAttach).toHaveBeenCalledOnce();
    expect(mockState.sessionSpawn).not.toHaveBeenCalled();
    expect(mockState.sessionResize).toHaveBeenCalledWith({
      sessionId: "shell-1",
      cols: 80,
      rows: 24,
    });
    expect(mockState.sessionRefreshTheme).toHaveBeenCalledWith({ sessionId: "shell-1" });
  });

  it("attach-first の replay を live Channel より先に復元し perception には流さない", async () => {
    const attach = deferred<{ attached: boolean; replay: number[] }>();
    mockState.sessionAttach.mockReturnValueOnce(attach.promise);
    const runtime = getTerminalRuntime("shell-1");
    const terminal = mockState.terminals[0];
    const channel = mockState.channels[0];
    const perception = { onCommandBlock: vi.fn(), onPtyOutput: vi.fn(), onUserInput: vi.fn() };

    runtime.setPerception(perception as unknown as Perception);
    runtime.updatePtyParams({ spec: shellSpec, cwd: null }, { attachFirst: true });
    await flushMicrotasks();

    channel.onmessage?.(new Uint8Array([66]).buffer);
    expect(terminal.writes).toHaveLength(0);

    attach.resolve({ attached: true, replay: [65] });
    await flushMicrotasks();

    expect(terminal.writes).toEqual([new Uint8Array([65]), new Uint8Array([66])]);
    expect(perception.onPtyOutput).toHaveBeenCalledOnce();
    expect(perception.onPtyOutput).toHaveBeenCalledWith("B");
  });

  it("OSC 633/133 から command run を作成して finalize する", async () => {
    const runtime = getTerminalRuntime("shell-1");
    const perception = { onCommandBlock: vi.fn(), onPtyOutput: vi.fn(), onUserInput: vi.fn() };
    const started = vi.fn();

    runtime.setPerception(perception as unknown as Perception);
    runtime.subscribeCommandRunStarted(started);
    runtime.updatePtyParams({ spec: shellSpec, cwd: null });
    await flushMicrotasks();
    mockState.oscHandlers.get(633)?.(`P;Cwd=${encodeOsc633Value("/repo")}`);
    mockState.oscHandlers.get(633)?.(`E;${encodeOsc633Value("npm test")}`);
    mockState.oscHandlers.get(133)?.("C");
    mockState.oscHandlers.get(133)?.("D;1");

    const runs = runtime.getCommandRunsRecent();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      sessionId: "shell-1",
      command: "npm test",
      cwd: "/repo",
      status: "failed",
      completedBy: "osc133",
      exitCode: 1,
    });
    expect(started).toHaveBeenCalledOnce();
    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "npm test",
        status: "running",
      }),
    );
    expect(runs[0].startMarker?.line).toBe(1);
    expect(runs[0].endMarker?.line).toBe(2);
    expect(perception.onCommandBlock).toHaveBeenCalledWith({
      command: "npm test",
      exitCode: 1,
      durationMs: expect.any(Number),
      sessionId: "shell-1",
    });

    // badge は廃止し、command block の hover→クリックで attach menu を開く方式に再設計。
    // menu の DOM 配置は xterm の rect 計測に依存し jsdom では検証しづらいので、
    // menu が叩く public attach verb の経路を直接検証する。
    expect(runtime.getTerminalReferences()).toHaveLength(0);
    expect(runtime.attachCommandRunOutput(1)).toBe(true);

    expect(runtime.getLatestRegionContext()).toMatchObject({
      sessionId: "shell-1",
      gesture: "command-run-click",
      commandRunId: 1,
      text: "$ npm test\nfailed output",
      range: {
        startRow: 1,
        endRow: 2,
      },
    });
    expect(runtime.getTerminalReferences()).toMatchObject([
      {
        id: "shell-1:Term1",
        context: {
          commandRunId: 1,
          gesture: "command-run-click",
        },
      },
    ]);
    expect(mockState.sessionWrite).toHaveBeenCalledWith({
      sessionId: "shell-1",
      data: "[#Term1] ",
    });
  });

  it("attachLastFailedRun が直近 failed run の reference を作る", async () => {
    const runtime = getTerminalRuntime("shell-1");
    runtime.updatePtyParams({ spec: shellSpec, cwd: null });
    await flushMicrotasks();
    mockState.oscHandlers.get(633)?.(`E;${encodeOsc633Value("npm test")}`);
    mockState.oscHandlers.get(133)?.("C");
    mockState.oscHandlers.get(133)?.("D;1");

    const ok = runtime.attachLastFailedRun();

    expect(ok).toBe(true);
    expect(runtime.getLatestRegionContext()).toMatchObject({
      sessionId: "shell-1",
      gesture: "command-run-click",
      commandRunId: 1,
    });
    expect(runtime.getTerminalReferences()).toHaveLength(1);
  });

  it("attachLastFailedRun は failed run が無ければ false で reference を作らない", async () => {
    const runtime = getTerminalRuntime("shell-1");
    runtime.updatePtyParams({ spec: shellSpec, cwd: null });
    await flushMicrotasks();
    mockState.oscHandlers.get(633)?.(`E;${encodeOsc633Value("true")}`);
    mockState.oscHandlers.get(133)?.("C");
    mockState.oscHandlers.get(133)?.("D;0");

    expect(runtime.attachLastFailedRun()).toBe(false);
    expect(runtime.getTerminalReferences()).toHaveLength(0);
  });

  it("attachCommandRunOutput が指定 run の reference を作る", async () => {
    const runtime = getTerminalRuntime("shell-1");
    runtime.updatePtyParams({ spec: shellSpec, cwd: null });
    await flushMicrotasks();
    mockState.oscHandlers.get(633)?.(`E;${encodeOsc633Value("npm test")}`);
    mockState.oscHandlers.get(133)?.("C");
    mockState.oscHandlers.get(133)?.("D;0");

    const ok = runtime.attachCommandRunOutput(1);

    expect(ok).toBe(true);
    expect(runtime.getLatestRegionContext()).toMatchObject({ commandRunId: 1 });
    expect(runtime.getTerminalReferences()).toHaveLength(1);
  });

  it("attachCommandRunOutput は存在しない runId で false", async () => {
    const runtime = getTerminalRuntime("shell-1");
    runtime.updatePtyParams({ spec: shellSpec, cwd: null });
    await flushMicrotasks();

    expect(runtime.attachCommandRunOutput(999)).toBe(false);
    expect(runtime.getTerminalReferences()).toHaveLength(0);
  });

  // block navigation 用に status 違いの run を 3 本作る。
  // 各 run は start(C)/finalize(D) で marker を 2 つ消費するので
  // startMarker.line は run1=1 / run2=3 / run3=5 になる（mock の連番 marker）。
  async function seedThreeRuns(): Promise<ReturnType<typeof getTerminalRuntime>> {
    const runtime = getTerminalRuntime("shell-1");
    runtime.updatePtyParams({ spec: shellSpec, cwd: null });
    await flushMicrotasks();
    const make = (command: string, exitCode: number) => {
      mockState.oscHandlers.get(633)?.(`E;${encodeOsc633Value(command)}`);
      mockState.oscHandlers.get(133)?.("C");
      mockState.oscHandlers.get(133)?.(`D;${exitCode}`);
    };
    make("echo ok", 0); // run1 succeeded, startMarker.line = 1
    make("npm test", 1); // run2 failed, startMarker.line = 3
    make("ls", 0); // run3 succeeded, startMarker.line = 5
    return runtime;
  }

  it("scrollToAdjacentCommandRun(next) は viewport より下の最も近い run へ scroll する", async () => {
    const runtime = await seedThreeRuns();
    const buffer = (mockState.terminals[0] as unknown as { buffer: MockBuffer }).buffer.active;
    // viewport を run1 の start 行に置く → next は run2(line=3)
    buffer.viewportY = 1;

    expect(runtime.scrollToAdjacentCommandRun("next")).toBe(true);
    expect(mockState.scrollToLineCalls).toEqual([3]);

    // 続けて next で run3(line=5)
    expect(runtime.scrollToAdjacentCommandRun("next")).toBe(true);
    expect(mockState.scrollToLineCalls).toEqual([3, 5]);
  });

  it("scrollToAdjacentCommandRun(previous) は viewport より上の最も近い run へ scroll する", async () => {
    const runtime = await seedThreeRuns();
    const buffer = (mockState.terminals[0] as unknown as { buffer: MockBuffer }).buffer.active;
    // viewport を run3 の start 行に置く → previous は run2(line=3)
    buffer.viewportY = 5;

    expect(runtime.scrollToAdjacentCommandRun("previous")).toBe(true);
    expect(mockState.scrollToLineCalls).toEqual([3]);

    // 続けて previous で run1(line=1)
    expect(runtime.scrollToAdjacentCommandRun("previous")).toBe(true);
    expect(mockState.scrollToLineCalls).toEqual([3, 1]);
  });

  it("scrollToAdjacentCommandRun は端で false を返し scroll しない", async () => {
    const runtime = await seedThreeRuns();
    const buffer = (mockState.terminals[0] as unknown as { buffer: MockBuffer }).buffer.active;

    // 最下段 run より下では next 先が無い
    buffer.viewportY = 5;
    expect(runtime.scrollToAdjacentCommandRun("next")).toBe(false);
    // 最上段 run より上では previous 先が無い
    buffer.viewportY = 1;
    expect(runtime.scrollToAdjacentCommandRun("previous")).toBe(false);
    expect(mockState.scrollToLineCalls).toEqual([]);
  });

  it("scrollToAdjacentCommandRun(failedOnly) は failed run だけを対象に jump する", async () => {
    const runtime = await seedThreeRuns();
    const buffer = (mockState.terminals[0] as unknown as { buffer: MockBuffer }).buffer.active;
    // run1(succeeded,1) に居る → failedOnly next は run2(failed,3) を飛ばさず狙う
    buffer.viewportY = 1;

    expect(runtime.scrollToAdjacentCommandRun("next", { failedOnly: true })).toBe(true);
    expect(mockState.scrollToLineCalls).toEqual([3]);

    // run2(failed,3) から先に failed が無いので next は false
    expect(runtime.scrollToAdjacentCommandRun("next", { failedOnly: true })).toBe(false);
    expect(mockState.scrollToLineCalls).toEqual([3]);
  });

  it("scrollToAdjacentCommandRun は run が無ければ false", async () => {
    const runtime = getTerminalRuntime("shell-1");
    runtime.updatePtyParams({ spec: shellSpec, cwd: null });
    await flushMicrotasks();

    expect(runtime.scrollToAdjacentCommandRun("next")).toBe(false);
    expect(runtime.scrollToAdjacentCommandRun("previous")).toBe(false);
    expect(mockState.scrollToLineCalls).toEqual([]);
  });

  it("active run 中の duplicate OSC C は started 通知を増やさない", async () => {
    const runtime = getTerminalRuntime("shell-1");
    const started = vi.fn();

    runtime.subscribeCommandRunStarted(started);
    runtime.updatePtyParams({ spec: shellSpec, cwd: null });
    await flushMicrotasks();
    mockState.oscHandlers.get(633)?.(`E;${encodeOsc633Value("printf one | cat")}`);
    mockState.oscHandlers.get(133)?.("C");
    mockState.oscHandlers.get(633)?.(`E;${encodeOsc633Value("cat")}`);
    mockState.oscHandlers.get(133)?.("C");

    expect(runtime.getCommandRunsRecent()).toHaveLength(1);
    expect(runtime.getCommandRunsRecent()[0]?.command).toBe("printf one | cat");
    expect(started).toHaveBeenCalledOnce();
  });

  it("running run でも start marker 起点の locus を返す", async () => {
    const runtime = getTerminalRuntime("shell-1");

    runtime.updatePtyParams({ spec: shellSpec, cwd: null });
    await flushMicrotasks();
    mockState.oscHandlers.get(633)?.(`E;${encodeOsc633Value("sleep 20")}`);
    mockState.oscHandlers.get(133)?.("C");

    expect(runtime.getCommandRunLocus(1)).toMatchObject({
      commandRunId: 1,
      range: { startRow: 1, endRow: 2, startCol: 0, endCol: 79 },
    });
  });

  it("command run が viewport 外なら locus を返さない", async () => {
    const runtime = getTerminalRuntime("shell-1");
    const terminal = mockState.terminals[0] as unknown as {
      buffer: { active: { viewportY: number } };
    };

    runtime.updatePtyParams({ spec: shellSpec, cwd: null });
    await flushMicrotasks();
    mockState.oscHandlers.get(633)?.(`E;${encodeOsc633Value("npm test")}`);
    mockState.oscHandlers.get(133)?.("C");
    mockState.oscHandlers.get(133)?.("D;1");

    expect(runtime.getCommandRunLocus(1)).not.toBeNull();
    terminal.buffer.active.viewportY = 10;

    expect(runtime.getCommandRunLocus(1)).toBeNull();
  });

  it("integration:false shell では command run を作らない", async () => {
    const runtime = getTerminalRuntime("shell-1");

    runtime.updatePtyParams({ spec: { kind: "shell", integration: false }, cwd: null });
    await flushMicrotasks();
    mockState.oscHandlers.get(633)?.(`E;${encodeOsc633Value("npm test")}`);
    mockState.oscHandlers.get(133)?.("C");
    mockState.oscHandlers.get(133)?.("D;0");

    expect(runtime.getCommandRunsRecent()).toHaveLength(0);
  });

  it("agent session では command run を作らない", async () => {
    const runtime = getTerminalRuntime("shell-1");

    runtime.updatePtyParams({ spec: { kind: "agent", agent: "codex" }, cwd: null });
    await flushMicrotasks();
    mockState.oscHandlers.get(633)?.(`E;${encodeOsc633Value("npm test")}`);
    mockState.oscHandlers.get(133)?.("C");
    mockState.oscHandlers.get(133)?.("D;0");

    expect(runtime.getCommandRunsRecent()).toHaveLength(0);
  });

  it("OSC D が無い running run を pty-exit で finalize する", async () => {
    const runtime = getTerminalRuntime("shell-1");

    runtime.updatePtyParams({ spec: shellSpec, cwd: null });
    await flushMicrotasks();
    mockState.oscHandlers.get(633)?.(`E;${encodeOsc633Value("sleep 1")}`);
    mockState.oscHandlers.get(133)?.("C");
    await vi.waitFor(() => {
      expect(mockState.eventListeners.get("pty-exit")?.length ?? 0).toBeGreaterThan(0);
    });

    for (const listener of mockState.eventListeners.get("pty-exit") ?? []) {
      listener({ payload: { session_id: "shell-1", code: 0 } });
    }

    expect(runtime.getCommandRunsRecent()[0]).toMatchObject({
      command: "sleep 1",
      status: "succeeded",
      completedBy: "pty-exit",
      exitCode: 0,
    });
  });

  it("destroys a PTY when an in-flight spawn completes after dispose", async () => {
    const spawn = deferred<void>();
    mockState.sessionSpawn.mockReturnValueOnce(spawn.promise);
    const runtime = getTerminalRuntime("shell-1");

    runtime.updatePtyParams({ spec: shellSpec, cwd: null });
    await flushMicrotasks();
    expect(mockState.sessionSpawn).toHaveBeenCalledOnce();

    disposeTerminalRuntime("shell-1");
    spawn.resolve(undefined);
    await flushMicrotasks();

    expect(mockState.sessionDestroy).toHaveBeenCalledWith({ sessionId: "shell-1" });
  });

  it("ignores channel output after dispose", () => {
    const runtime = getTerminalRuntime("shell-1");
    const terminal = mockState.terminals[0];
    const channel = mockState.channels[0];

    channel.onmessage?.(new Uint8Array([65]).buffer);
    expect(terminal.writes).toHaveLength(1);

    runtime.dispose();
    channel.onmessage?.(new Uint8Array([66]).buffer);

    expect(terminal.disposed).toBe(true);
    expect(terminal.writes).toHaveLength(1);
  });

  // attachTo は同期的に syncAttachedRect を 1 回呼ぶ（RAF を回さなくても
  // per-frame visibility 強制経路を踏める）。singleton xtermContainer は
  // document.body 直下にいるので dataset 経由で引く。
  const xtermSingleton = (): HTMLElement => {
    const el = document.body.querySelector<HTMLElement>(".xterm-singleton-container");
    if (!el) throw new Error("xterm singleton container not found");
    return el;
  };

  it("syncAttachedRect は setHidden(true) のとき visibility:visible を強制しない", () => {
    const runtime = getTerminalRuntime("shell-1");
    runtime.setHidden(true);

    const stub = document.createElement("div");
    document.body.appendChild(stub);
    // attachTo が内部で syncAttachedRect を 1 回呼ぶ（root cause の経路）
    runtime.attachTo(stub);

    expect(xtermSingleton().style.visibility).toBe("hidden");

    runtime.detachContainer();
    stub.remove();
  });

  it("setHidden しなければ syncAttachedRect で visibility:visible になる（既存挙動）", () => {
    const runtime = getTerminalRuntime("shell-1");

    const stub = document.createElement("div");
    document.body.appendChild(stub);
    runtime.attachTo(stub);

    expect(xtermSingleton().style.visibility).toBe("visible");

    runtime.detachContainer();
    stub.remove();
  });

  it("attachTo は常駐 resize RAF を開始しない", () => {
    const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(() => 42);
    const runtime = getTerminalRuntime("shell-1");

    const stub = document.createElement("div");
    document.body.appendChild(stub);
    runtime.attachTo(stub);

    expect(rafSpy).not.toHaveBeenCalled();

    runtime.detachContainer();
    stub.remove();
    rafSpy.mockRestore();
  });

  it("setOpacity(0.5) で .xterm-singleton-container の style.opacity が 0.5 になる", () => {
    const runtime = getTerminalRuntime("shell-1");
    runtime.setOpacity(0.5);
    expect(xtermSingleton().style.opacity).toBe("0.5");
  });

  it("setOpacity は attachTo + syncAttachedRect をまたいでも維持される（per-frame sync が opacity を戻さない）", () => {
    const runtime = getTerminalRuntime("shell-1");
    runtime.setOpacity(0.5);

    const stub = document.createElement("div");
    document.body.appendChild(stub);
    // attachTo が内部で syncAttachedRect を 1 回呼ぶ（per-frame 経路）
    runtime.attachTo(stub);

    expect(xtermSingleton().style.opacity).toBe("0.5");

    runtime.detachContainer();
    stub.remove();
  });

  it("getOpacity は setOpacity で設定した値を返す（未設定時は 1）", () => {
    const runtime = getTerminalRuntime("shell-1");
    expect(runtime.getOpacity()).toBe(1);
    runtime.setOpacity(0.4);
    expect(runtime.getOpacity()).toBe(0.4);
  });

  it("setOpacity しなければ opacity は未設定（既定で完全不透明）", () => {
    const runtime = getTerminalRuntime("shell-1");

    const stub = document.createElement("div");
    document.body.appendChild(stub);
    runtime.attachTo(stub);

    // 一度も setOpacity していなければ inline style.opacity は触られない
    expect(xtermSingleton().style.opacity).toBe("");

    runtime.detachContainer();
    stub.remove();
  });

  // setBackgroundTransparent — 背景のみ透明・文字は不透明のまま。
  // theme.background の値と、container に付く scoped class の両方を確認する。
  const themeBg = (): unknown => {
    const term = mockState.terminals[0] as unknown as { options: { theme?: unknown } };
    return (term.options.theme as { background?: unknown } | undefined)?.background;
  };

  it("setBackgroundTransparent(true) で theme.background が透明色になり class が付く", () => {
    const runtime = getTerminalRuntime("shell-1");
    runtime.setBackgroundTransparent(true);

    expect(themeBg()).toBe("rgba(0,0,0,0)");
    expect(xtermSingleton().classList.contains("xterm-bg-transparent")).toBe(true);
  });

  it("bgTransparent 中の setTheme は不透明 background を上書きしない（flag-reassert）", () => {
    const runtime = getTerminalRuntime("shell-1");
    runtime.setBackgroundTransparent(true);
    runtime.setTheme({ background: "#123456" });

    // scene 由来の不透明 background は透明で再上書きされる
    expect(themeBg()).toBe("rgba(0,0,0,0)");
    expect(xtermSingleton().classList.contains("xterm-bg-transparent")).toBe(true);
  });

  it("setBackgroundTransparent(false) で直近 theme の background へ復帰し class が外れる", () => {
    const runtime = getTerminalRuntime("shell-1");
    runtime.setTheme({ background: "#123456" });
    runtime.setBackgroundTransparent(true);
    expect(themeBg()).toBe("rgba(0,0,0,0)");

    runtime.setBackgroundTransparent(false);
    expect(themeBg()).toBe("#123456");
    expect(xtermSingleton().classList.contains("xterm-bg-transparent")).toBe(false);
  });

  // production の正規順序：transparent(true) → scene が full theme を setTheme →
  // transparent(false) で復帰したとき scene の background へ戻る（既定でも透明でもなく）。
  it("bgTransparent 中の full setTheme 後に解除すると scene の background へ復帰する", () => {
    const runtime = getTerminalRuntime("shell-1");
    runtime.setBackgroundTransparent(true);
    runtime.setTheme({
      background: "#abcdef",
      foreground: "#101010",
      cursor: "#202020",
      black: "#000000",
      white: "#ffffff",
    });
    // bgTransparent 中は flag-reassert で透明のまま
    expect(themeBg()).toBe("rgba(0,0,0,0)");

    runtime.setBackgroundTransparent(false);
    expect(themeBg()).toBe("#abcdef");
  });

  // fix #1 の回帰ガード：background キーを持たない partial setTheme が
  // bgTransparent 中に来ても、復帰先に stale な "rgba(0,0,0,0)" を焼き込まない。
  it("bgTransparent 中の background なし partial setTheme は復帰先を汚染しない", () => {
    const runtime = getTerminalRuntime("shell-1");
    runtime.setTheme({ background: "#123456" });
    runtime.setBackgroundTransparent(true);
    // background キーなし（merged theme は stale な "rgba(0,0,0,0)"）
    runtime.setTheme({ foreground: "#ffffff" });
    expect(themeBg()).toBe("rgba(0,0,0,0)");

    runtime.setBackgroundTransparent(false);
    // 直近の「本物の」background へ戻る（透明を焼き込んでいない）
    expect(themeBg()).toBe("#123456");
  });

  it("setBackgroundTransparent しなければ透明化されず class も付かない（既定）", () => {
    getTerminalRuntime("shell-1"); // runtime/terminal を生成（呼ばずに既定を確認）

    expect(themeBg()).toBe("#0f1923");
    expect(xtermSingleton().classList.contains("xterm-bg-transparent")).toBe(false);
  });
});

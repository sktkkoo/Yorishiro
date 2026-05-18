// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _clearForTest } from "../hot-data/hot-data";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
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
    terminals: Array<{ writes: unknown[]; disposed: boolean }>;
    fitCalls: number;
    focusCalls: number;
    unlisten: ReturnType<typeof vi.fn>;
    listen: ReturnType<typeof vi.fn>;
    sessionAttach: ReturnType<typeof vi.fn>;
    sessionDestroy: ReturnType<typeof vi.fn>;
    sessionResize: ReturnType<typeof vi.fn>;
    sessionSpawn: ReturnType<typeof vi.fn>;
    sessionWrite: ReturnType<typeof vi.fn>;
  } = {
    channels: [],
    terminals: [],
    fitCalls: 0,
    focusCalls: 0,
    unlisten: vi.fn(),
    listen: vi.fn(),
    sessionAttach: vi.fn(),
    sessionDestroy: vi.fn(),
    sessionResize: vi.fn(),
    sessionSpawn: vi.fn(),
    sessionWrite: vi.fn(),
  };
  state.listen.mockResolvedValue(state.unlisten);
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
    disposed = false;
    buffer = { active: null };

    constructor(options: { theme?: unknown }) {
      this.options = options;
      mockState.terminals.push(this);
    }

    loadAddon(): void {}
    open(): void {}
    reset(): void {
      this.writes = [];
    }
    write(data: unknown): void {
      this.writes.push(data);
    }
    dispose(): void {
      this.disposed = true;
    }
    onData(): void {}
    onResize(): void {}
    onScroll(): void {}
    focus(): void {
      mockState.focusCalls++;
    }
    refresh(): void {}
    clear(): void {}
  },
}));

vi.mock("../../bindings/tauri-commands", () => ({
  sessionAttach: mockState.sessionAttach,
  sessionDestroy: mockState.sessionDestroy,
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
    mockState.channels.length = 0;
    mockState.terminals.length = 0;
    mockState.fitCalls = 0;
    mockState.focusCalls = 0;
    mockState.unlisten.mockClear();
    mockState.listen.mockClear();
    mockState.listen.mockResolvedValue(mockState.unlisten);
    mockState.sessionAttach.mockReset();
    mockState.sessionAttach.mockResolvedValue(false);
    mockState.sessionDestroy.mockReset();
    mockState.sessionDestroy.mockResolvedValue(undefined);
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
    const attach = deferred<boolean>();
    mockState.sessionAttach.mockReturnValueOnce(attach.promise);
    const runtime = getTerminalRuntime("shell-1");

    runtime.updatePtyParams({ spec: shellSpec, cwd: null }, { attachFirst: true });
    await flushMicrotasks();
    expect(mockState.sessionAttach).toHaveBeenCalledOnce();

    disposeTerminalRuntime("shell-1");
    attach.resolve(false);
    await flushMicrotasks();

    expect(mockState.sessionSpawn).not.toHaveBeenCalled();
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
});

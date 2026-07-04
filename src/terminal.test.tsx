// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnSpec } from "./bindings/tauri-commands";
import Terminal from "./terminal";

const mockState = vi.hoisted(() => {
  const disposables = {
    pty: { dispose: vi.fn() },
    notification: { dispose: vi.fn() },
    userInput: { dispose: vi.fn() },
    activation: { dispose: vi.fn() },
  };
  const status = {
    register: vi.fn(),
    markActive: vi.fn(),
    markOutput: vi.fn(),
    settleOutput: vi.fn(),
    markScreenAttentionRequest: vi.fn(),
    clearScreenAttention: vi.fn(),
    markAttentionRequest: vi.fn(),
    clearAttention: vi.fn(),
  };
  const runtime = {
    attachTo: vi.fn(),
    detachContainer: vi.fn(),
    focus: vi.fn(),
    readScreenTailText: vi.fn(() => ""),
    setInterruptProtectionMode: vi.fn(),
    setPerception: vi.fn(),
    setTheme: vi.fn(),
    subscribeActivation: vi.fn(() => disposables.activation),
    subscribeNotification: vi.fn(() => disposables.notification),
    subscribePtyData: vi.fn((listener: () => void) => {
      state.ptyListener = listener;
      return disposables.pty;
    }),
    subscribeUserInput: vi.fn(() => disposables.userInput),
    updatePtyParams: vi.fn(),
  };
  const state = {
    disposables,
    ptyListener: null as (() => void) | null,
    runtime,
    status,
  };
  return state;
});

vi.mock("./runtime/terminal-runtime", () => ({
  getTerminalRuntime: vi.fn(() => mockState.runtime),
}));

vi.mock("./runtime/session-status", () => ({
  detectScreenAttentionRequest: vi.fn(() => null),
  getSessionStatusStore: vi.fn(() => mockState.status),
  isAttentionClearingInput: vi.fn(() => false),
  isOscAttentionNotificationMessage: vi.fn(() => false),
}));

vi.mock("./runtime/terminal-theme", () => ({
  getCurrentTerminalTheme: vi.fn(() => ({})),
}));

vi.mock("./bindings/tauri-commands", () => ({
  sessionRefreshTheme: vi.fn(() => Promise.resolve()),
}));

describe("Terminal", () => {
  const spec = { kind: "agent", agent: "claude" } satisfies SpawnSpec;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    mockState.ptyListener = null;
    vi.clearAllMocks();
  });

  it("debounces PTY output timers without recreating them for every chunk", () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");

    render(
      <Terminal
        sessionId="main"
        visible={true}
        active={true}
        spec={spec}
        cwd="/work/old"
        perception={null}
      />,
    );

    mockState.ptyListener?.();
    vi.advanceTimersByTime(40);
    mockState.ptyListener?.();

    expect(mockState.status.markOutput).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    expect(clearTimeoutSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(40);
    expect(mockState.runtime.readScreenTailText).not.toHaveBeenCalled();
    expect(mockState.status.settleOutput).not.toHaveBeenCalled();

    vi.advanceTimersByTime(40);
    expect(mockState.runtime.readScreenTailText).toHaveBeenCalledTimes(1);
    expect(mockState.status.clearScreenAttention).toHaveBeenCalledTimes(1);
    expect(mockState.status.settleOutput).not.toHaveBeenCalled();

    vi.advanceTimersByTime(720);
    expect(mockState.status.settleOutput).toHaveBeenCalledTimes(1);
  });
});

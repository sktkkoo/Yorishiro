// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnSpec } from "./bindings/tauri-commands";
import TabIndicator from "./components/TabIndicator";
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
    setAttentionCueIntensity: vi.fn(),
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
  const cueListeners = new Set<() => void>();
  const cueStore = {
    current: null as { seq: number; startedAt: number; reason: "session-attention" | "mcp" } | null,
    getCurrent: vi.fn(() => cueStore.current),
    subscribe: vi.fn((listener: () => void) => {
      cueListeners.add(listener);
      return () => {
        cueListeners.delete(listener);
      };
    }),
  };
  const state = {
    cueListeners,
    cueStore,
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

vi.mock("./runtime/attention-light-cue", () => ({
  getAttentionLightCueStore: vi.fn(() => mockState.cueStore),
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
    mockState.cueListeners.clear();
    mockState.cueStore.current = null;
    mockState.ptyListener = null;
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it.each([
    true,
    false,
  ])("respects keyboard focus visibility (%s) when session tabs activate", (keyboardFocusVisible) => {
    // jsdom drops :focus-visible when React updates tabindex after programmatic focus.
    // Model browser keyboard/pointer modality while exercising both components' effects.
    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector) {
      if (selector === '[role="tab"]:focus-visible') {
        return (
          this.getAttribute("role") === "tab" &&
          document.activeElement === this &&
          keyboardFocusVisible
        );
      }
      return matches.call(this, selector);
    });
    function Sessions() {
      const [activeSessionId, setActiveSessionId] = useState("main");
      return (
        <>
          <TabIndicator
            state={{ sessions: ["main", "shell"], mainSessionId: "main", activeSessionId }}
            labels={new Map()}
            onSelectSession={setActiveSessionId}
          />
          {["main", "shell"].map((sessionId) => (
            <Terminal
              key={sessionId}
              sessionId={sessionId}
              active={sessionId === activeSessionId}
              visible={sessionId === activeSessionId}
              spec={spec}
              cwd={null}
              perception={null}
            />
          ))}
        </>
      );
    }
    render(<Sessions />);
    const [main, shell] = screen.getAllByRole("tab");
    main.focus();
    mockState.runtime.focus.mockClear();

    if (keyboardFocusVisible) fireEvent.keyDown(main, { key: "ArrowRight" });
    else {
      shell.focus();
      fireEvent.click(shell);
    }
    expect(shell.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(shell);
    expect(mockState.runtime.focus).toHaveBeenCalledTimes(keyboardFocusVisible ? 0 : 1);

    if (keyboardFocusVisible) fireEvent.keyDown(shell, { key: "ArrowRight" });
    else {
      main.focus();
      fireEvent.click(main);
    }
    expect(main.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(main);
    expect(mockState.runtime.focus).toHaveBeenCalledTimes(keyboardFocusVisible ? 0 : 2);
  });

  it("still focuses an activated terminal when focus is outside the tablist", () => {
    const { rerender } = render(
      <Terminal
        sessionId="main"
        visible={false}
        active={false}
        spec={spec}
        cwd={null}
        perception={null}
      />,
    );
    expect(mockState.runtime.focus).not.toHaveBeenCalled();
    rerender(<Terminal sessionId="main" visible active spec={spec} cwd={null} perception={null} />);
    expect(mockState.runtime.focus).toHaveBeenCalledOnce();
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

  it("does not replay an elapsed attention light cue when a tab becomes visible again", () => {
    vi.setSystemTime(10_000);
    mockState.cueStore.current = {
      seq: 1,
      startedAt: 1_000,
      reason: "session-attention",
    };

    const { rerender } = render(
      <Terminal
        sessionId="main"
        visible={false}
        active={false}
        spec={spec}
        cwd="/work/old"
        perception={null}
      />,
    );
    rerender(
      <Terminal
        sessionId="main"
        visible={true}
        active={true}
        spec={spec}
        cwd="/work/old"
        perception={null}
      />,
    );

    vi.advanceTimersByTime(500);

    const intensities = mockState.runtime.setAttentionCueIntensity.mock.calls.map(
      ([value]) => value,
    );
    expect(intensities.every((value) => value === 0)).toBe(true);
  });
});

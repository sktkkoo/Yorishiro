// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { installQuickChatKeybinding, supportsQuickChatForViewMode } from "./quick-chat-input";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function dispatchKey(type: "keydown" | "keyup", init: KeyboardEventInit): void {
  window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
}

describe("quick chat availability", () => {
  it("allows the bundled character-first modes only", () => {
    expect(supportsQuickChatForViewMode("companion")).toBe(true);
    expect(supportsQuickChatForViewMode("portrait")).toBe(true);
    expect(supportsQuickChatForViewMode("theater")).toBe(true);
    expect(supportsQuickChatForViewMode("immersive")).toBe(false);
    expect(supportsQuickChatForViewMode(null)).toBe(false);
    expect(supportsQuickChatForViewMode("custom-ui")).toBe(false);
  });
});

describe("quick chat modifier-tap keybinding", () => {
  it("invokes after Command is pressed and released by itself", () => {
    const onInvoke = vi.fn();
    const cleanup = installQuickChatKeybinding({ macos: true, onInvoke });

    dispatchKey("keydown", { key: "Meta", code: "MetaLeft", metaKey: true });
    expect(onInvoke).not.toHaveBeenCalled();
    dispatchKey("keyup", { key: "Meta", code: "MetaLeft" });

    expect(onInvoke).toHaveBeenCalledOnce();
    cleanup();
  });

  it("does not invoke for a Command chord", () => {
    const onInvoke = vi.fn();
    const cleanup = installQuickChatKeybinding({ macos: true, onInvoke });

    dispatchKey("keydown", { key: "Meta", code: "MetaLeft", metaKey: true });
    dispatchKey("keydown", { key: "r", code: "KeyR", metaKey: true });
    dispatchKey("keyup", { key: "Meta", code: "MetaLeft" });

    expect(onInvoke).not.toHaveBeenCalled();
    cleanup();
  });

  it("cancels a modifier tap when a pointer gesture occurs", () => {
    const onInvoke = vi.fn();
    const cleanup = installQuickChatKeybinding({ macos: true, onInvoke });

    dispatchKey("keydown", { key: "Meta", code: "MetaLeft", metaKey: true });
    window.dispatchEvent(new PointerEvent("pointerdown"));
    dispatchKey("keyup", { key: "Meta", code: "MetaLeft" });

    expect(onInvoke).not.toHaveBeenCalled();
    cleanup();
  });

  it("uses Control outside macOS", () => {
    const onInvoke = vi.fn();
    const cleanup = installQuickChatKeybinding({ macos: false, onInvoke });

    dispatchKey("keydown", { key: "Control", code: "ControlLeft", ctrlKey: true });
    dispatchKey("keyup", { key: "Control", code: "ControlLeft" });

    expect(onInvoke).toHaveBeenCalledOnce();
    cleanup();
  });

  it("starts a momentary voice hold after the threshold and ends it on release", () => {
    vi.useFakeTimers();
    const onInvoke = vi.fn();
    const onHoldStart = vi.fn();
    const onHoldEnd = vi.fn();
    const cleanup = installQuickChatKeybinding({
      macos: true,
      onInvoke,
      onHoldStart,
      onHoldEnd,
      holdDelayMs: 360,
    });

    dispatchKey("keydown", { key: "Meta", code: "MetaLeft", metaKey: true });
    vi.advanceTimersByTime(359);
    expect(onHoldStart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onHoldStart).toHaveBeenCalledOnce();

    dispatchKey("keyup", { key: "Meta", code: "MetaLeft" });
    expect(onHoldEnd).toHaveBeenCalledOnce();
    expect(onInvoke).not.toHaveBeenCalled();
    cleanup();
  });

  it("ends an active voice hold if the window loses focus", () => {
    vi.useFakeTimers();
    const onHoldEnd = vi.fn();
    const cleanup = installQuickChatKeybinding({
      macos: true,
      onInvoke: vi.fn(),
      onHoldStart: vi.fn(),
      onHoldEnd,
      holdDelayMs: 360,
    });

    dispatchKey("keydown", { key: "Meta", code: "MetaLeft", metaKey: true });
    vi.advanceTimersByTime(360);
    window.dispatchEvent(new Event("blur"));

    expect(onHoldEnd).toHaveBeenCalledOnce();
    cleanup();
  });
});

// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  createLocalMicrophoneControl,
  installMicrophoneMuteShortcut,
  type LocalMicrophoneAdapter,
} from "./local-microphone";

function adapter(overrides: Partial<LocalMicrophoneAdapter> = {}): LocalMicrophoneAdapter {
  return {
    transportId: "gpt-live",
    connection: "active",
    muted: false,
    captureActive: true,
    interrupted: false,
    setMuted: vi.fn(),
    ...overrides,
  };
}

describe("host local microphone control", () => {
  it.each([
    "gpt-live",
    "future-meeting",
  ])("uses the same input-only control for %s", (transportId) => {
    const input = adapter({ transportId });
    const control = createLocalMicrophoneControl(input);
    expect(control).toMatchObject({
      transportId,
      connected: true,
      sending: true,
      status: "sending",
    });
    control.toggleMute();
    expect(input.setMuted).toHaveBeenCalledWith(true);
  });

  it("separates device interruption from mute intent and stale capture liveness", () => {
    expect(createLocalMicrophoneControl(adapter({ muted: true }))).toMatchObject({
      muted: true,
      sending: false,
      status: "muted",
    });
    expect(createLocalMicrophoneControl(adapter({ muted: true, interrupted: true }))).toMatchObject(
      { muted: true, sending: false, status: "interrupted" },
    );
    for (const connection of ["idle", "connecting", "error"] as const) {
      const input = adapter({ connection });
      const control = createLocalMicrophoneControl(input);
      expect(control.sending).toBe(false);
      control.toggleMute();
      expect(input.setMuted).not.toHaveBeenCalled();
    }
  });

  it.each([
    true,
    false,
  ])("toggles with the focused-app shortcut (macos=%s) and releases its listener", (macos) => {
    let muted = false;
    const setMuted = vi.fn((next: boolean) => {
      muted = next;
    });
    const cleanup = installMicrophoneMuteShortcut({
      macos,
      getControl: () => createLocalMicrophoneControl(adapter({ muted, setMuted })),
    });
    const press = (extra: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", {
        code: "KeyM",
        shiftKey: true,
        metaKey: macos,
        ctrlKey: !macos,
        cancelable: true,
        ...extra,
      });
      window.dispatchEvent(event);
      return event;
    };
    for (const invalid of [
      { shiftKey: false },
      { altKey: true },
      { repeat: true },
      { isComposing: true },
      { code: "KeyN" },
      { metaKey: !macos, ctrlKey: macos },
    ]) {
      expect(press(invalid).defaultPrevented).toBe(false);
    }
    expect(setMuted).not.toHaveBeenCalled();
    expect(press().defaultPrevented).toBe(true);
    expect(muted).toBe(true);
    press();
    expect(muted).toBe(false);
    expect(setMuted).toHaveBeenCalledTimes(2);
    cleanup();
    expect(press().defaultPrevented).toBe(false);
    expect(setMuted).toHaveBeenCalledTimes(2);
  });

  it("does not consume the shortcut while disconnected", () => {
    const input = adapter({ connection: "idle" });
    const cleanup = installMicrophoneMuteShortcut({
      macos: true,
      getControl: () => createLocalMicrophoneControl(input),
    });
    const event = new KeyboardEvent("keydown", {
      code: "KeyM",
      metaKey: true,
      shiftKey: true,
      cancelable: true,
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(input.setMuted).not.toHaveBeenCalled();
    cleanup();
  });

  it("handles the shortcut before terminal or editor handlers consume keyboard events", () => {
    const input = adapter();
    const cleanup = installMicrophoneMuteShortcut({
      macos: true,
      getControl: () => createLocalMicrophoneControl(input),
    });
    const terminal = document.createElement("textarea");
    document.body.append(terminal);
    const consume = vi.fn((event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    terminal.addEventListener("keydown", consume);
    const event = new KeyboardEvent("keydown", {
      code: "KeyM",
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    terminal.dispatchEvent(event);
    expect(input.setMuted).toHaveBeenCalledWith(true);
    expect(event.defaultPrevented).toBe(true);
    expect(consume).not.toHaveBeenCalled();
    cleanup();
    terminal.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "KeyM",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(consume).toHaveBeenCalledOnce();
    terminal.remove();
  });
});

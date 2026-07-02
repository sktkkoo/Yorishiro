// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { installTabKeybindings } from "./keybindings";
import type { SessionTabManager } from "./session-tab-manager";

function dispatchKeydown(init: KeyboardEventInit): void {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
  );
}

describe("installTabKeybindings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens a new shell tab with the provided cwd on Cmd+T", () => {
    const manager = {
      openShell: vi.fn(),
    } as unknown as SessionTabManager;
    const cleanup = installTabKeybindings(manager, {
      getNewSessionCwd: () => "/work/current",
    });

    dispatchKeydown({ key: "t", metaKey: true });
    cleanup();

    expect(manager.openShell).toHaveBeenCalledWith("/work/current");
  });

  it("falls back to null when Cmd+T has no cwd provider", () => {
    const manager = {
      openShell: vi.fn(),
    } as unknown as SessionTabManager;
    const cleanup = installTabKeybindings(manager);

    dispatchKeydown({ key: "t", metaKey: true });
    cleanup();

    expect(manager.openShell).toHaveBeenCalledWith(null);
  });
});

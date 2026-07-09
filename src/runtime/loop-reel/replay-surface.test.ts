// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { getSurfaceRegistry } from "../surface-registry";
import { resolveReplayTerminalSurface } from "./replay-surface";

describe("resolveReplayTerminalSurface", () => {
  afterEach(() => {
    const registered = getSurfaceRegistry().get("terminal");
    if (registered) getSurfaceRegistry().unregister("terminal", registered);
    document.body.innerHTML = "";
  });

  it("uses the registered terminal surface before class selector fallback", () => {
    const registered = document.createElement("div");
    registered.style.visibility = "visible";
    Object.defineProperty(registered, "getBoundingClientRect", {
      value: () => ({ top: 10, left: 20, width: 800, height: 600 }),
    });
    document.body.appendChild(registered);
    getSurfaceRegistry().register("terminal", registered);

    const xterm = document.createElement("div");
    xterm.className = "xterm-singleton-container";
    xterm.style.visibility = "visible";
    Object.defineProperty(xterm, "getBoundingClientRect", {
      value: () => ({ top: 16, left: 300, width: 900, height: 680 }),
    });
    document.body.appendChild(xterm);

    expect(resolveReplayTerminalSurface()).toBe(registered);
  });

  it("uses the visible live xterm surface before the placeholder", () => {
    const active = document.createElement("div");
    active.className = "terminal-container";
    active.dataset.sessionId = "shell-1";
    active.dataset.active = "true";
    document.body.appendChild(active);

    const xterm = document.createElement("div");
    xterm.className = "xterm-singleton-container";
    xterm.style.visibility = "visible";
    Object.defineProperty(xterm, "getBoundingClientRect", {
      value: () => ({ top: 16, left: 300, width: 900, height: 680 }),
    });
    document.body.appendChild(xterm);

    expect(resolveReplayTerminalSurface()).toBe(xterm);
  });

  it("uses the active terminal placeholder when live xterm is hidden", () => {
    const inactive = document.createElement("div");
    inactive.className = "terminal-container";
    inactive.dataset.sessionId = "default-session";
    inactive.dataset.active = "false";
    document.body.appendChild(inactive);

    const active = document.createElement("div");
    active.className = "terminal-container";
    active.dataset.sessionId = "shell-1";
    active.dataset.active = "true";
    document.body.appendChild(active);

    const hiddenXterm = document.createElement("div");
    hiddenXterm.className = "xterm-singleton-container";
    hiddenXterm.style.visibility = "hidden";
    Object.defineProperty(hiddenXterm, "getBoundingClientRect", {
      value: () => ({ top: 16, left: 300, width: 900, height: 680 }),
    });
    document.body.appendChild(hiddenXterm);

    expect(resolveReplayTerminalSurface()).toBe(active);
  });

  it("falls back to the terminal placeholder before active state is stamped", () => {
    const terminal = document.createElement("div");
    terminal.className = "terminal-container";
    document.body.appendChild(terminal);

    expect(resolveReplayTerminalSurface()).toBe(terminal);
  });
});

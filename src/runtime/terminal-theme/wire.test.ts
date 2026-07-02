// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneSpec } from "../../sdk/scene";
import { _clearForTest } from "../hot-data/hot-data";
import type { ScenePackEntry } from "../scene-pack-registry";
import { ScenePackRegistryImpl } from "../scene-pack-registry";

const DEFAULT_THEME = vi.hoisted(() => ({
  background: "#141619",
  foreground: "#e8ebe7",
  cursor: "#8eb09c",
  green: "#9cbd8a",
}));

vi.mock("../terminal-runtime", () => ({
  DEFAULT_TERMINAL_THEME: DEFAULT_THEME,
}));

const { getCurrentTerminalTheme, initTerminalTheme, resolveTerminalTheme } = await import("./wire");

function scene(id: string, overrides: Pick<SceneSpec, "terminal" | "ui"> = {}): SceneSpec {
  return {
    id,
    layers: [],
    ...overrides,
  };
}

function entry(id: string, sceneSpec: SceneSpec): ScenePackEntry {
  return {
    id,
    manifest: {
      id,
      type: "scene",
      version: "0.0.0",
      charminalVersion: "^0.1.0",
      entry: "scene.ts",
    },
    scene: sceneSpec,
    origin: "bundled",
  };
}

describe("terminal theme wire", () => {
  beforeEach(() => {
    _clearForTest();
    document.documentElement.removeAttribute("style");
  });

  afterEach(() => {
    _clearForTest();
    document.documentElement.removeAttribute("style");
  });

  it("resolves each scene terminal theme from defaults without leaking previous scene fields", () => {
    const first = resolveTerminalTheme(
      scene("first", {
        terminal: {
          background: "#101820",
          foreground: "#f6f6f0",
          green: "#00aa55",
        },
      }),
    );
    const second = resolveTerminalTheme(
      scene("second", {
        terminal: {
          background: "#d6dcc8",
        },
      }),
    );

    expect(first).toMatchObject({
      background: "#101820",
      foreground: "#f6f6f0",
      green: "#00aa55",
    });
    expect(second).toMatchObject({
      background: "#d6dcc8",
      foreground: DEFAULT_THEME.foreground,
      green: DEFAULT_THEME.green,
    });
  });

  it("keeps current terminal theme and UI vars in sync with active scene changes", () => {
    const registry = new ScenePackRegistryImpl();
    registry.register(
      entry(
        "forest",
        scene("forest", {
          terminal: {
            background: "#d6dcc8",
            foreground: "#5c6a72",
          },
          ui: {
            background: "#d6dcc8",
            foreground: "#1e2a1a",
            buttonForeground: "#27351f",
          },
        }),
      ),
    );
    registry.register(
      entry(
        "factory",
        scene("factory", {
          terminal: {
            background: "#1a1a19",
          },
          ui: {
            background: "#181818",
            foreground: "#9a9a94",
            buttonForeground: "#8a8a84",
          },
        }),
      ),
    );

    const sub = initTerminalTheme(registry);
    expect(getCurrentTerminalTheme()).toMatchObject({
      background: "#1a1a19",
      foreground: DEFAULT_THEME.foreground,
    });
    expect(document.documentElement.style.getPropertyValue("--charminal-bg")).toBe("#181818");
    expect(document.documentElement.style.getPropertyValue("--charminal-button-fg")).toBe(
      "#8a8a84",
    );

    registry.setActiveScene("forest");
    expect(getCurrentTerminalTheme()).toMatchObject({
      background: "#d6dcc8",
      foreground: "#5c6a72",
    });
    expect(document.documentElement.style.getPropertyValue("--charminal-bg")).toBe("#d6dcc8");
    expect(document.documentElement.style.getPropertyValue("--charminal-button-fg")).toBe(
      "#27351f",
    );

    sub.dispose();
  });
});

// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _clearForTest as clearHotDataForTest } from "./runtime/hot-data/hot-data";
import { _resetForTest as resetPresenceForTest } from "./runtime/presence-intensity/presence-intensity";
import type { UiPackEntry } from "./runtime/ui-pack-registry";
import { getUiRegistry } from "./runtime/ui-pack-registry";
import {
  activePresentationViewModeId,
  buildViewModeShortcuts,
  matchesViewModeShortcut,
  nativeWindowControlsVisibleForViewMode,
  resolvePickerActiveViewModeId,
  roundedWindowForViewMode,
  shouldShowProjectSelector,
  sortViewModeEntries,
  useActiveUiId,
  useSettingsActive,
  useSidebarOpen,
} from "./title-bar-state";

const SETTINGS_PACK_ID = "yorishiro-settings";

function SidebarOpenProbe() {
  const sidebarOpen = useSidebarOpen();
  return <output aria-label="sidebar-open">{sidebarOpen ? "open" : "closed"}</output>;
}

function SettingsActiveProbe() {
  const settingsActive = useSettingsActive(SETTINGS_PACK_ID);
  return <output aria-label="settings-active">{settingsActive ? "active" : "inactive"}</output>;
}

function ActiveUiProbe() {
  const activeUiId = useActiveUiId();
  return <output aria-label="active-ui">{activeUiId ?? "none"}</output>;
}

function uiEntry(id: string): UiPackEntry {
  return {
    id,
    origin: "bundled",
    manifest: {} as UiPackEntry["manifest"],
    pack: {
      layout: {} as UiPackEntry["pack"]["layout"],
      mount: () => ({ dispose: () => {} }),
    },
  };
}

beforeEach(() => {
  clearHotDataForTest();
  resetPresenceForTest();
});

afterEach(() => {
  cleanup();
  clearHotDataForTest();
});

describe("title bar state hooks", () => {
  it("assigns real, collision-resistant shortcuts to Terminal and the first nine modes", () => {
    const shortcuts = buildViewModeShortcuts(
      Array.from({ length: 10 }, (_, index) => ({ id: `mode-${index + 1}` })),
      true,
    );

    expect(shortcuts).toHaveLength(10);
    expect(shortcuts[0]).toEqual({ id: null, code: "Digit0", hint: "⌥⌘0" });
    expect(shortcuts[1]).toEqual({ id: "mode-1", code: "Digit1", hint: "⌥⌘1" });
    expect(shortcuts[shortcuts.length - 1]?.id).toBe("mode-9");
    expect(
      matchesViewModeShortcut(
        shortcuts[1],
        { code: "Digit1", ctrlKey: false, altKey: true, shiftKey: false, metaKey: true },
        true,
      ),
    ).toBe(true);
    expect(
      matchesViewModeShortcut(
        shortcuts[1],
        { code: "Digit1", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false },
        true,
      ),
    ).toBe(false);
    expect(
      matchesViewModeShortcut(
        buildViewModeShortcuts([{ id: "mode-1" }], false)[1],
        { code: "Digit1", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false },
        false,
      ),
    ).toBe(true);
  });

  it("keeps the finalized built-in order ahead of deterministic user modes", () => {
    const ordered = sortViewModeEntries([
      uiEntry("user-z"),
      uiEntry("immersive"),
      uiEntry("portrait"),
      uiEntry("theater"),
      uiEntry("companion"),
      uiEntry("user-a"),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual([
      "companion",
      "portrait",
      "theater",
      "immersive",
      "user-a",
      "user-z",
    ]);
    expect(buildViewModeShortcuts(ordered, true).map(({ id, hint }) => [id, hint])).toEqual([
      [null, "⌥⌘0"],
      ["companion", "⌥⌘1"],
      ["portrait", "⌥⌘2"],
      ["theater", "⌥⌘3"],
      ["immersive", "⌥⌘4"],
      ["user-a", "⌥⌘5"],
      ["user-z", "⌥⌘6"],
    ]);
  });

  it("shows native window controls only for Terminal", () => {
    expect(nativeWindowControlsVisibleForViewMode(null)).toBe(true);
    expect(nativeWindowControlsVisibleForViewMode("theater")).toBe(false);
    expect(nativeWindowControlsVisibleForViewMode("user-view-mode")).toBe(false);
  });

  it("rounds only windowed compact presentation modes", () => {
    expect(roundedWindowForViewMode("companion")).toBe(true);
    expect(roundedWindowForViewMode("portrait")).toBe(true);
    expect(roundedWindowForViewMode("theater")).toBe(false);
    expect(roundedWindowForViewMode("immersive")).toBe(false);
    expect(roundedWindowForViewMode(null)).toBe(false);
  });

  it("syncs sidebarOpen from presence level change events", () => {
    render(<SidebarOpenProbe />);

    expect(screen.getByLabelText("sidebar-open").textContent).toBe("open");

    act(() => {
      window.dispatchEvent(
        new CustomEvent("yorishiro:presence-level-changed", { detail: { level: "closed" } }),
      );
    });

    expect(screen.getByLabelText("sidebar-open").textContent).toBe("closed");

    act(() => {
      window.dispatchEvent(
        new CustomEvent("yorishiro:presence-level-changed", { detail: { level: "default" } }),
      );
    });

    expect(screen.getByLabelText("sidebar-open").textContent).toBe("open");
  });

  it("syncs settingsActive from the active UI registry", () => {
    const registry = getUiRegistry();
    const settingsRegistration = registry.register(uiEntry(SETTINGS_PACK_ID));
    const otherRegistration = registry.register(uiEntry("attention-aura"));
    registry.setActiveUi("attention-aura");

    try {
      render(<SettingsActiveProbe />);

      expect(screen.getByLabelText("settings-active").textContent).toBe("inactive");

      act(() => {
        registry.setActiveUi(SETTINGS_PACK_ID);
      });

      expect(screen.getByLabelText("settings-active").textContent).toBe("active");

      act(() => {
        registry.setActiveUi("attention-aura");
      });

      expect(screen.getByLabelText("settings-active").textContent).toBe("inactive");
    } finally {
      settingsRegistration.dispose();
      otherRegistration.dispose();
    }
  });

  it("syncs active UI id from the active UI registry", () => {
    const registry = getUiRegistry();
    const companionRegistration = registry.register(uiEntry("companion"));

    try {
      render(<ActiveUiProbe />);
      expect(screen.getByLabelText("active-ui").textContent).toBe("none");

      act(() => {
        registry.setActiveUi("companion");
      });
      expect(screen.getByLabelText("active-ui").textContent).toBe("companion");
    } finally {
      companionRegistration.dispose();
    }
  });

  it("shows Terminal while Settings was opened from Terminal", () => {
    const terminalOrigin = resolvePickerActiveViewModeId(true, null, SETTINGS_PACK_ID);
    const portraitOrigin = resolvePickerActiveViewModeId(true, "portrait", SETTINGS_PACK_ID);
    expect(terminalOrigin).toBeNull();
    expect(portraitOrigin).toBe("portrait");
    expect(shouldShowProjectSelector(true, terminalOrigin)).toBe(true);
    expect(shouldShowProjectSelector(true, portraitOrigin)).toBe(false);
    // The same origin value drives camera ownership before, during, and after Settings.
    expect(resolvePickerActiveViewModeId(false, null, "portrait")).toBe(portraitOrigin);
    expect(resolvePickerActiveViewModeId(false, null, null)).toBe(terminalOrigin);
  });

  it("keeps the previous picker selection but suspends presentation chrome in Settings", () => {
    const pickerId = resolvePickerActiveViewModeId(true, "portrait", SETTINGS_PACK_ID);
    const settingsPresentationId = activePresentationViewModeId(true, pickerId);
    expect(pickerId).toBe("portrait");
    expect(settingsPresentationId).toBeNull();
    expect(nativeWindowControlsVisibleForViewMode(settingsPresentationId)).toBe(true);
    expect(roundedWindowForViewMode(settingsPresentationId)).toBe(false);
    expect(activePresentationViewModeId(false, pickerId)).toBe("portrait");
  });

  it("does not flash the project selector before persisted View Mode bootstrap resolves", () => {
    expect(shouldShowProjectSelector(false, null)).toBe(false);
    expect(shouldShowProjectSelector(true, "companion")).toBe(false);
    expect(shouldShowProjectSelector(true, SETTINGS_PACK_ID)).toBe(false);
    expect(shouldShowProjectSelector(true, null)).toBe(true);
  });
});

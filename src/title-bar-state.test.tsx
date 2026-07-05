// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _clearForTest as clearHotDataForTest } from "./runtime/hot-data/hot-data";
import { _resetForTest as resetPresenceForTest } from "./runtime/presence-intensity/presence-intensity";
import type { UiPackEntry } from "./runtime/ui-pack-registry";
import { getUiRegistry } from "./runtime/ui-pack-registry";
import { useSettingsActive, useSidebarOpen } from "./title-bar-state";

const SETTINGS_PACK_ID = "yorishiro-settings";

function SidebarOpenProbe() {
  const sidebarOpen = useSidebarOpen();
  return <output aria-label="sidebar-open">{sidebarOpen ? "open" : "closed"}</output>;
}

function SettingsActiveProbe() {
  const settingsActive = useSettingsActive(SETTINGS_PACK_ID);
  return <output aria-label="settings-active">{settingsActive ? "active" : "inactive"}</output>;
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
  it("syncs sidebarOpen from presence level change events", () => {
    render(<SidebarOpenProbe />);

    expect(screen.getByLabelText("sidebar-open").textContent).toBe("open");

    act(() => {
      window.dispatchEvent(
        new CustomEvent("charminal:presence-level-changed", { detail: { level: "closed" } }),
      );
    });

    expect(screen.getByLabelText("sidebar-open").textContent).toBe("closed");

    act(() => {
      window.dispatchEvent(
        new CustomEvent("charminal:presence-level-changed", { detail: { level: "default" } }),
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
});

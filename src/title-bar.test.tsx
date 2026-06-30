// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TitleBar from "./title-bar";

function renderTitleBar(overrides: Partial<Parameters<typeof TitleBar>[0]> = {}) {
  return render(
    <TitleBar
      sidebarOpen
      settingsActive={false}
      sidebarLabel="Sidebar"
      settingsLabel="Settings"
      onToggleSidebar={vi.fn()}
      onOpenSettings={vi.fn()}
      {...overrides}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TitleBar", () => {
  it("calls onToggleSidebar when the sidebar button is clicked", () => {
    const onToggleSidebar = vi.fn();
    renderTitleBar({ onToggleSidebar });

    fireEvent.click(screen.getByRole("button", { name: "Sidebar" }));

    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
  });

  it("calls onOpenSettings when the settings button is clicked", () => {
    const onOpenSettings = vi.fn();
    renderTitleBar({ onOpenSettings });

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("reflects sidebarOpen through aria-pressed", () => {
    const { rerender } = renderTitleBar({ sidebarOpen: true });
    const sidebarButton = screen.getByRole("button", { name: "Sidebar" });

    expect(sidebarButton.getAttribute("aria-pressed")).toBe("true");

    rerender(
      <TitleBar
        sidebarOpen={false}
        settingsActive={false}
        sidebarLabel="Sidebar"
        settingsLabel="Settings"
        onToggleSidebar={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Sidebar" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("marks the settings button as active while settings is open", () => {
    renderTitleBar({ settingsActive: true });

    const settingsButton = screen.getByRole("button", { name: "Settings" });
    expect(settingsButton.classList.contains("is-active")).toBe(true);
    expect(settingsButton.getAttribute("aria-pressed")).toBe("true");
  });

  it("renders tabs inside the title bar", () => {
    renderTitleBar({ tabs: <button type="button">shell-1</button> });

    expect(screen.getByRole("button", { name: "shell-1" })).toBeTruthy();
  });

  it("keeps only the title bar root as a Tauri drag region", () => {
    const { container } = renderTitleBar();
    const root = container.firstElementChild;

    expect(root?.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(
      screen.getByRole("button", { name: "Sidebar" }).hasAttribute("data-tauri-drag-region"),
    ).toBe(false);
    expect(
      screen.getByRole("button", { name: "Settings" }).hasAttribute("data-tauri-drag-region"),
    ).toBe(false);
  });
});

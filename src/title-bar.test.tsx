// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiPackEntry } from "./runtime/ui-pack-registry";
import TitleBar from "./title-bar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const portrait = {
  id: "portrait",
  origin: "bundled",
  manifest: {
    id: "portrait",
    type: "ui",
    version: "1.0.0",
    yorishiroVersion: "*",
    entry: "ui.tsx",
    viewMode: { enabled: true, label: "Call", icon: "portrait", order: 50 },
  },
  pack: { layout: {}, mount: () => ({ dispose() {} }) },
} satisfies UiPackEntry;

function renderTitleBar(overrides: Partial<Parameters<typeof TitleBar>[0]> = {}) {
  return render(
    <TitleBar
      onToggleSidebar={vi.fn()}
      onOpenSettings={vi.fn()}
      sidebarOpen
      settingsActive={false}
      settingsLabel="Settings"
      sidebarLabel="Sidebar"
      viewModeLabel="View Mode"
      terminalLabel="Terminal"
      settingsShortcutHint="⌘,"
      {...overrides}
    />,
  );
}

describe("TitleBar View Mode picker", () => {
  it("exposes active state and selects a mode in two clicks", () => {
    const select = vi.fn();
    renderTitleBar({
      viewModes: [portrait],
      activeViewModeId: "portrait",
      onSelectViewMode: select,
    });
    fireEvent.click(screen.getByRole("button", { name: "View Mode" }));
    const item = screen.getByRole("menuitemradio", { name: "Call" });
    expect(item.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(item);
    expect(select).toHaveBeenCalledWith("portrait");
  });

  it("opens and focuses from the trigger, then supports arrow navigation and Escape", async () => {
    renderTitleBar({ viewModes: [portrait], activeViewModeId: "portrait" });
    const trigger = screen.getByRole("button", { name: "View Mode" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const terminal = screen.getByRole("menuitemradio", { name: "Terminal" });
    await waitFor(() => expect(document.activeElement).toBe(terminal));
    fireEvent.keyDown(terminal, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Call" }));
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
  });

  it("uses caller-provided localized labels", () => {
    renderTitleBar({ viewModeLabel: "表示モード", terminalLabel: "Terminal" });
    fireEvent.click(screen.getByRole("button", { name: "表示モード" }));
    expect(screen.getByRole("menu", { name: "表示モード" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Terminal" })).toBeTruthy();
  });

  it("opens with Enter from the trigger and focuses the first item", async () => {
    renderTitleBar({ viewModes: [portrait] });
    const trigger = screen.getByRole("button", { name: "View Mode" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    const terminal = screen.getByRole("menuitemradio", { name: "Terminal" });
    await waitFor(() => expect(document.activeElement).toBe(terminal));
  });

  it("shows only wired shortcut hints in the compact HUD menu", () => {
    renderTitleBar({
      viewModes: [portrait],
      terminalShortcutHint: "⌥⌘0",
      viewModeShortcutHints: { portrait: "⌥⌘1" },
      settingsShortcutHint: "⌘,",
    });
    fireEvent.click(screen.getByRole("button", { name: "View Mode" }));
    expect(screen.getByRole("menuitemradio", { name: "Terminal (⌥⌘0)" }).textContent).toContain(
      "⌥⌘0",
    );
    expect(screen.getByRole("menuitemradio", { name: "Call (⌥⌘1)" }).textContent).toContain("⌥⌘1");
    expect(screen.getByRole("menuitem", { name: "Settings (⌘,)" }).textContent).toContain("⌘,");
  });
});

describe("TitleBar existing controls", () => {
  it("calls onToggleSidebar when the sidebar button is clicked", () => {
    const onToggleSidebar = vi.fn();
    renderTitleBar({ onToggleSidebar });
    fireEvent.click(screen.getByRole("button", { name: "Sidebar" }));
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
  });

  it("does not render the sidebar toggle when it is hidden", () => {
    renderTitleBar({ showSidebarToggle: false });
    expect(screen.queryByRole("button", { name: "Sidebar" })).toBeNull();
  });

  it("calls onOpenSettings when the settings button is clicked", () => {
    const onOpenSettings = vi.fn();
    renderTitleBar({ onOpenSettings });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("reflects sidebarOpen through aria-pressed", () => {
    const { rerender } = renderTitleBar({ sidebarOpen: true });
    expect(screen.getByRole("button", { name: "Sidebar" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    rerender(
      <TitleBar
        sidebarOpen={false}
        settingsActive={false}
        sidebarLabel="Sidebar"
        settingsLabel="Settings"
        viewModeLabel="View Mode"
        terminalLabel="Terminal"
        settingsShortcutHint="⌘,"
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
    const button = screen.getByRole("button", { name: "Settings" });
    expect(button.classList.contains("is-active")).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("renders tabs inside the title bar", () => {
    renderTitleBar({ tabs: <button type="button">shell-1</button> });
    expect(screen.getByRole("button", { name: "shell-1" })).toBeTruthy();
  });

  it("shows the GPT Live voice control only when available", () => {
    const onToggleVoice = vi.fn();
    const { rerender } = renderTitleBar();
    expect(screen.queryByRole("button", { name: "Start voice" })).toBeNull();
    rerender(
      <TitleBar
        sidebarOpen
        settingsActive={false}
        sidebarLabel="Sidebar"
        settingsLabel="Settings"
        viewModeLabel="View Mode"
        terminalLabel="Terminal"
        settingsShortcutHint="⌘,"
        voiceAvailable
        voiceState="idle"
        voiceLabel="Start voice"
        onToggleVoice={onToggleVoice}
        onToggleSidebar={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start voice" }));
    expect(onToggleVoice).toHaveBeenCalledTimes(1);
  });

  it("keeps the GPT Live control visible but blocks it during a session transition", () => {
    const onToggleVoice = vi.fn();
    renderTitleBar({
      voiceAvailable: true,
      voiceDisabled: true,
      voiceState: "idle",
      voiceLabel: "Start voice",
      onToggleVoice,
    });
    const button = screen.getByRole("button", { name: "Start voice" });
    expect(button.getAttribute("disabled")).not.toBeNull();
    fireEvent.click(button);
    expect(onToggleVoice).not.toHaveBeenCalled();
  });

  it("shows a plain unpressed mic while idle", () => {
    renderTitleBar({
      voiceAvailable: true,
      voiceState: "idle",
      voiceLabel: "Start voice",
      onToggleVoice: vi.fn(),
    });
    const button = screen.getByRole("button", { name: "Start voice" });
    expect(button.getAttribute("data-voice-state")).toBe("idle");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.querySelector(".lucide-mic")).toBeTruthy();
    expect(button.querySelector(".lucide-mic-off")).toBeNull();
  });

  it("shows a spinner and aria-busy while connecting", () => {
    renderTitleBar({
      voiceAvailable: true,
      voiceState: "connecting",
      voiceLabel: "Connecting voice…",
      onToggleVoice: vi.fn(),
    });
    const button = screen.getByRole("button", { name: "Connecting voice…" });
    expect(button.getAttribute("data-voice-state")).toBe("connecting");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.querySelector(".lucide-loader-circle")).toBeTruthy();
    expect(button.querySelector(".lucide-mic")).toBeNull();
  });

  it("keeps the plain mic while the conversation is live", () => {
    renderTitleBar({
      voiceAvailable: true,
      voiceState: "active",
      voiceMicrophoneActive: true,
      voiceLabel: "Stop voice",
      onToggleVoice: vi.fn(),
    });
    const button = screen.getByRole("button", { name: "Stop voice" });
    expect(button.getAttribute("data-voice-state")).toBe("active");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.querySelector(".lucide-mic")).toBeTruthy();
    expect(button.querySelector(".lucide-mic-off")).toBeNull();
    expect(button.querySelector(".title-bar-voice-status-dot")).toBeTruthy();
  });

  it("hides the red dot while microphone capture is interrupted", () => {
    renderTitleBar({
      voiceAvailable: true,
      voiceState: "active",
      voiceMicrophoneActive: false,
      voiceLabel: "Stop voice",
      onToggleVoice: vi.fn(),
    });
    const button = screen.getByRole("button", { name: "Stop voice" });
    expect(button.getAttribute("data-microphone-active")).toBe("false");
    expect(button.querySelector(".title-bar-voice-status-dot")).toBeNull();
  });

  it("exposes the error state for retry with an alert message", () => {
    renderTitleBar({
      voiceAvailable: true,
      voiceState: "error",
      voiceLabel: "Retry voice",
      voiceError: "connection failed",
      onToggleVoice: vi.fn(),
    });
    const button = screen.getByRole("button", { name: "Retry voice" });
    expect(button.getAttribute("data-voice-state")).toBe("error");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("alert").textContent).toBe("connection failed");
  });

  it("does not inline animation styles so reduced-motion CSS can disable the spinner", () => {
    renderTitleBar({
      voiceAvailable: true,
      voiceState: "connecting",
      voiceLabel: "Connecting voice…",
      onToggleVoice: vi.fn(),
    });
    const svg = screen
      .getByRole("button", { name: "Connecting voice…" })
      .querySelector(".lucide-loader-circle");
    expect(svg?.getAttribute("style") ?? "").not.toContain("animation");
  });

  it("marks the empty tab area as a Tauri drag region while keeping controls interactive", () => {
    const { container } = renderTitleBar();
    expect(container.firstElementChild?.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(container.querySelector(".title-bar-tabs")?.hasAttribute("data-tauri-drag-region")).toBe(
      true,
    );
    expect(
      screen.getByRole("button", { name: "Sidebar" }).hasAttribute("data-tauri-drag-region"),
    ).toBe(false);
    expect(
      screen.getByRole("button", { name: "Settings" }).hasAttribute("data-tauri-drag-region"),
    ).toBe(false);
  });
});

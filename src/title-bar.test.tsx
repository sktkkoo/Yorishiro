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

  // active はスラッシュ無しの Mic のまま。MicOff は「ミュート」の慣習アイコンで、
  // ユーザー操作のミュートが存在しない現状ではどの状態にも出さない。
  it("keeps the plain mic (never a slashed mic) while the conversation is live", () => {
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

  it("hides the red dot while the conversation is live but microphone capture is interrupted", () => {
    renderTitleBar({
      voiceAvailable: true,
      voiceState: "active",
      voiceMicrophoneActive: false,
      voiceLabel: "Stop voice",
      onToggleVoice: vi.fn(),
    });

    const button = screen.getByRole("button", { name: "Stop voice" });
    expect(button.getAttribute("data-voice-state")).toBe("active");
    expect(button.getAttribute("data-microphone-active")).toBe("false");
    expect(button.getAttribute("aria-pressed")).toBe("true");
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
    expect(button.querySelector(".lucide-mic")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("connection failed");
  });

  // 回転 animation は CSS class（data-voice-state="connecting"）にだけ紐づける。
  // inline style で animation を焼き込むと prefers-reduced-motion の media query で
  // 止められなくなる。
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
    const root = container.firstElementChild;
    const tabs = container.querySelector(".title-bar-tabs");

    expect(root?.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(tabs?.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(
      screen.getByRole("button", { name: "Sidebar" }).hasAttribute("data-tauri-drag-region"),
    ).toBe(false);
    expect(
      screen.getByRole("button", { name: "Settings" }).hasAttribute("data-tauri-drag-region"),
    ).toBe(false);
  });
});

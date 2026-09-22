// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceApproval } from "./runtime/codex-realtime/voice-approval";
import TitleBar, { type TitleBarProps } from "./title-bar";

afterEach(cleanup);

const approval: VoiceApproval = {
  requestId: 1,
  threadId: "thread",
  turnId: "turn",
  itemId: "item",
  code: "4827",
  command: 'echo "<script>untrusted</script>"',
  cwd: "/tmp/work directory",
  reason: "Read the requested file",
  details: '{"command": "echo test"}',
  canAccept: true,
  canDecline: true,
};

function props(overrides: Partial<TitleBarProps> = {}): TitleBarProps {
  return {
    onToggleSidebar: vi.fn(),
    onOpenSettings: vi.fn(),
    sidebarOpen: true,
    settingsActive: false,
    settingsLabel: "Settings",
    sidebarLabel: "Sidebar",
    viewModeLabel: "View mode",
    terminalLabel: "Terminal",
    settingsShortcutHint: "⌘,",
    voiceState: "active",
    onToggleVoiceApproval: vi.fn(),
    voiceApproval: approval,
    ...overrides,
  };
}

describe("voice approval review", () => {
  it("requires opt-in and hides the review outside an active session", () => {
    const toggle = vi.fn();
    const { rerender } = render(<TitleBar {...props({ onToggleVoiceApproval: toggle })} />);
    const button = screen.getByRole("button", { name: "Voice approval" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("region", { name: "Review voice approval" })).toBeNull();
    fireEvent.click(button);
    expect(toggle).toHaveBeenCalledOnce();
    rerender(<TitleBar {...props({ voiceState: "idle", voiceApprovalEnabled: true })} />);
    expect(screen.queryByRole("button", { name: "Voice approval" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Review voice approval" })).toBeNull();
  });

  it("shows exact operation data as text and leaves keyboard focus in place", () => {
    const { container } = render(<TitleBar {...props()} />);
    const button = screen.getByRole("button", { name: "Voice approval" });
    button.focus();
    const { unmount } = render(<TitleBar {...props({ voiceApprovalEnabled: true })} />);
    expect(document.activeElement).toBe(button);
    expect(screen.getByText(approval.command).textContent).toBe(approval.command);
    expect(screen.getByText(approval.cwd).textContent).toBe(approval.cwd);
    expect(screen.getByText(approval.reason)).toBeTruthy();
    expect(screen.getByText(approval.details)).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText("approve 4827 confirm")).toBeTruthy();
    expect(screen.getByText("deny 4827 confirm")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.querySelector("header")?.dataset.voiceApproval).toBe("false");
    unmount();
  });

  it("localizes instructions and only offers allowed decisions", () => {
    const { rerender } = render(
      <TitleBar
        {...props({
          language: "ja",
          voiceApprovalEnabled: true,
          voiceApproval: { ...approval, canAccept: false },
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "音声承認" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByText("拒否 4827 確定")).toBeTruthy();
    expect(screen.queryByText("承認 4827 確定")).toBeNull();
    rerender(
      <TitleBar
        {...props({
          voiceApprovalEnabled: true,
          voiceApproval: { ...approval, canDecline: false },
        })}
      />,
    );
    expect(screen.getByText("approve 4827 confirm")).toBeTruthy();
    expect(screen.queryByText("deny 4827 confirm")).toBeNull();
  });
});

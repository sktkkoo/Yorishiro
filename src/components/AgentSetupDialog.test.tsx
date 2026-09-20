// @vitest-environment jsdom

import { openUrl } from "@tauri-apps/plugin-opener";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_SETUP_GUIDES, type DetectedAgent } from "../runtime/agent-setup";
import { AgentSetupDialog, type AgentSetupDialogProps } from "./AgentSetupDialog";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

const agents: readonly DetectedAgent[] = [
  { id: "codex", displayName: "Codex", binaryName: "codex", path: null },
  { id: "claude", displayName: "Claude Code", binaryName: "claude", path: null },
];

function props(overrides: Partial<AgentSetupDialogProps> = {}): AgentSetupDialogProps {
  return {
    language: "en",
    agents,
    reason: "missing",
    busy: false,
    error: null,
    installations: {},
    onInstall: vi.fn(),
    onSelect: vi.fn(),
    onRefresh: vi.fn(),
    onSkip: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("AgentSetupDialog", () => {
  it("shows one shared account note above the agents without running anything on render", () => {
    const callbacks = props();
    render(<AgentSetupDialog {...callbacks} />);

    expect(screen.getByRole("dialog", { name: "Agent installation" })).toBeTruthy();
    const note = screen.getByText(/Sign in with your own account after installation/);
    expect(note.closest("header")).not.toBeNull();
    expect(note.closest("details")).toBeNull();
    expect(callbacks.onInstall).not.toHaveBeenCalled();
    expect(callbacks.onSelect).not.toHaveBeenCalled();
    expect(callbacks.onRefresh).not.toHaveBeenCalled();
    expect(callbacks.onSkip).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("installs only the explicitly chosen agent and keeps the other installation independent", () => {
    const callbacks = props();
    const { rerender } = render(<AgentSetupDialog {...callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "Codex: Install official CLI" }));
    expect(callbacks.onInstall).toHaveBeenCalledExactlyOnceWith("codex");
    expect(callbacks.onSelect).not.toHaveBeenCalled();

    rerender(
      <AgentSetupDialog
        {...callbacks}
        installations={{ codex: { phase: "installing", output: "Downloading Codex…" } }}
      />,
    );
    const pendingButton = screen.getByRole("button", { name: "Codex: Installing…" });
    expect((pendingButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(pendingButton);
    fireEvent.click(screen.getByRole("button", { name: "Claude Code: Install official CLI" }));
    expect(callbacks.onInstall).toHaveBeenNthCalledWith(2, "claude");
    expect(callbacks.onInstall).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Set up later" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(callbacks.onSkip).not.toHaveBeenCalled();
  });

  it("rechecks when returning from a manual install without starting another installer", () => {
    const callbacks = props();
    const { unmount } = render(<AgentSetupDialog {...callbacks} />);
    expect(callbacks.onRefresh).not.toHaveBeenCalled();
    fireEvent(window, new Event("focus"));
    expect(callbacks.onRefresh).toHaveBeenCalledOnce();
    expect(callbacks.onInstall).not.toHaveBeenCalled();
    unmount();
    fireEvent(window, new Event("focus"));
    expect(callbacks.onRefresh).toHaveBeenCalledOnce();
  });

  it("treats a detected path as installation, and starts only after a separate choice", () => {
    const callbacks = props({
      agents: [
        { ...agents[0], path: "/Users/test/.local/bin/codex" },
        agents[1],
        { id: "opencode", displayName: "OpenCode", binaryName: "opencode", path: "/bin/opencode" },
      ],
      reason: "choose",
    });
    render(<AgentSetupDialog {...callbacks} />);

    const codex = within(screen.getByRole("region", { name: "Codex" }));
    expect(codex.getByText("Installed")).toBeTruthy();
    expect(codex.queryByText(/signed in|logged in/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Codex: Install official CLI" })).toBeNull();
    expect(screen.getByRole("button", { name: "Use OpenCode" })).toBeTruthy();
    expect(callbacks.onSelect).not.toHaveBeenCalled();
    fireEvent.click(codex.getByRole("button", { name: "Use Codex" }));
    expect(callbacks.onSelect).toHaveBeenCalledExactlyOnceWith("codex");
    expect(callbacks.onInstall).not.toHaveBeenCalled();
  });

  it("retains failed-install logs and retries without starting an agent", () => {
    const callbacks = props({
      installations: {
        claude: {
          phase: "error",
          output: "Download failed: offline",
          error: "Network unavailable",
        },
      },
    });
    render(<AgentSetupDialog {...callbacks} />);
    const claude = within(screen.getByRole("region", { name: "Claude Code" }));
    expect(claude.getByRole("alert").textContent).toContain("Network unavailable");
    const log = claude.getByText("Download failed: offline");
    expect(log.closest("details")?.open).toBe(false);
    fireEvent.click(claude.getByRole("button", { name: "Claude Code: Retry installation" }));
    expect(callbacks.onInstall).toHaveBeenCalledExactlyOnceWith("claude");
    expect(callbacks.onSelect).not.toHaveBeenCalled();
  });

  it("opens official links with the system opener and copies commands without executing them", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const callbacks = props();
    render(<AgentSetupDialog {...callbacks} />);
    const codex = within(screen.getByRole("region", { name: "Codex" }));
    const details = codex.getByText("Details").closest("details");
    if (details) details.open = true;
    fireEvent.click(codex.getByRole("link", { name: /Official setup/ }));
    expect(openUrl).toHaveBeenCalledWith(AGENT_SETUP_GUIDES.codex?.url);
    fireEvent.click(codex.getByRole("link", { name: /Provider terms/ }));
    expect(openUrl).toHaveBeenCalledWith(AGENT_SETUP_GUIDES.codex?.termsUrl);

    fireEvent.click(codex.getByRole("button", { name: "Copy Codex install command" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(AGENT_SETUP_GUIDES.codex?.command));
    expect(callbacks.onInstall).not.toHaveBeenCalled();
  });

  it("traps keyboard focus, skips on Escape, and restores focus when closed", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const callbacks = props();
    const { unmount } = render(<AgentSetupDialog {...callbacks} />);
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2 }));

    fireEvent.keyDown(dialog, { key: "Tab" });
    const first = screen.getByRole("button", { name: "Codex: Install official CLI" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    const last = screen.getByRole("button", { name: "Set up later" });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(callbacks.onSkip).toHaveBeenCalledOnce();
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("offers official instructions instead of runnable installer controls on unsupported systems", () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32");
    render(<AgentSetupDialog {...props()} />);
    expect(screen.queryByRole("button", { name: "Codex: Install official CLI" })).toBeNull();
    expect(screen.queryByText("Install command")).toBeNull();
    for (const summary of screen.getAllByText("Details")) {
      const details = summary.closest("details");
      if (details) details.open = true;
    }
    expect(screen.getAllByRole("link", { name: /Official setup/ })).toHaveLength(2);
    expect(screen.getByText(/Use the official guide/)).toBeTruthy();
  });

  it("rechecks completed installations without reinstalling, and disables actions while checking", () => {
    const callbacks = props({
      language: "ja",
      installations: { codex: { phase: "complete", output: "Installed." } },
    });
    const { rerender } = render(<AgentSetupDialog {...callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "Codex: 再確認" }));
    expect(callbacks.onRefresh).toHaveBeenCalledOnce();
    expect(callbacks.onInstall).not.toHaveBeenCalled();
    rerender(<AgentSetupDialog {...callbacks} busy />);
    fireEvent.click(screen.getByRole("button", { name: "Claude Code: 公式からインストール" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(callbacks.onInstall).not.toHaveBeenCalled();
    expect(callbacks.onSkip).not.toHaveBeenCalled();
  });
});

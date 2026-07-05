// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../runtime/session-status";
import type { SessionTabState } from "../runtime/session-tabs/types";
import TabIndicator from "./TabIndicator";

afterEach(() => {
  cleanup();
});

const state = (activeSessionId = "default-session"): SessionTabState => ({
  sessions: ["default-session", "shell-1"],
  activeSessionId,
  mainSessionId: "default-session",
});

const baseStatus = (sessionId: string, overrides: Partial<SessionStatus> = {}): SessionStatus => ({
  sessionId,
  lifecycle: "running",
  activity: "idle",
  exitCode: null,
  attention: null,
  lastActivityAt: 1,
  unread: false,
  ...overrides,
});

describe("TabIndicator", () => {
  it("renders the main tab with a single session", () => {
    render(
      <TabIndicator
        state={{
          sessions: ["default-session"],
          activeSessionId: "default-session",
          mainSessionId: "default-session",
        }}
        labels={new Map([["default-session", "claude"]])}
      />,
    );

    expect(screen.getByRole("tab", { name: /claude/ })).toBeTruthy();
  });

  it("renders status icons without text badges", () => {
    const statuses = new Map([
      ["default-session", baseStatus("default-session", { activity: "running-command" })],
      [
        "shell-1",
        baseStatus("shell-1", {
          lifecycle: "exited",
          exitCode: 2,
          unread: true,
          attention: {
            title: "Claude",
            body: "Permission needed",
            receivedAt: 2,
            source: "hook",
          },
        }),
      ],
    ]);

    render(
      <TabIndicator
        state={state()}
        labels={
          new Map([
            ["default-session", "claude"],
            ["shell-1", "shell-1"],
          ])
        }
        statuses={statuses}
      />,
    );

    expect(screen.getByRole("tab", { name: /claude/ })).toBeTruthy();
    expect(screen.getByLabelText("Running")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /shell-1/ }).getAttribute("title")).toBe(
      "Claude: Permission needed",
    );
    expect(screen.getByLabelText("Failed")).toBeTruthy();
    expect(screen.getByText("!")).toBeTruthy();
    expect(screen.queryByText("run")).toBeNull();
    expect(screen.queryByText("failed")).toBeNull();
    expect(screen.queryByText("◆")).toBeNull();
  });

  it("keeps status icons and badges immediately after the tab label", () => {
    const statuses = new Map([
      ["default-session", baseStatus("default-session", { activity: "running-command" })],
      ["shell-1", baseStatus("shell-1", { activity: "awaiting-input" })],
    ]);

    render(
      <TabIndicator
        state={state()}
        labels={
          new Map([
            ["default-session", "claude"],
            ["shell-1", "~/Yorishiro"],
          ])
        }
        statuses={statuses}
        hookBadges={new Map([["shell-1", { label: "pre-tool-use", tone: "agent-hook" }]])}
      />,
    );

    const personaTab = screen.getByRole("tab", { name: /claude/ });
    const pathTab = screen.getByRole("tab", { name: /~\/Yorishiro/ });

    expect(personaTab.firstElementChild?.classList.contains("tab-indicator-label")).toBe(true);
    expect(pathTab.firstElementChild?.classList.contains("tab-indicator-label")).toBe(true);
    expect(pathTab.children[1]?.classList.contains("tab-indicator-state")).toBe(true);
    expect(pathTab.children[2]?.classList.contains("tab-indicator-hook-badge")).toBe(true);
  });

  it("does not render an ambiguous dot for unread idle tabs", () => {
    const statuses = new Map([
      ["default-session", baseStatus("default-session", { unread: true })],
    ]);

    render(
      <TabIndicator
        state={{
          sessions: ["default-session"],
          activeSessionId: "default-session",
          mainSessionId: "default-session",
        }}
        labels={new Map([["default-session", "claude"]])}
        statuses={statuses}
      />,
    );

    expect(screen.queryByLabelText("Unread output")).toBeNull();
    expect(document.querySelector(".tab-indicator-state.state-unread")).toBeNull();
  });

  it("renders awaiting input as a state icon", () => {
    const statuses = new Map([
      ["default-session", baseStatus("default-session", { activity: "awaiting-input" })],
    ]);

    render(
      <TabIndicator
        state={{
          sessions: ["default-session"],
          activeSessionId: "default-session",
          mainSessionId: "default-session",
        }}
        labels={new Map([["default-session", "claude"]])}
        statuses={statuses}
      />,
    );

    expect(screen.getByLabelText("Needs input")).toBeTruthy();
    expect(screen.queryByText("input")).toBeNull();
  });

  it("renders active hook labels without reserving empty badge slots", () => {
    render(
      <TabIndicator
        state={state()}
        labels={
          new Map([
            ["default-session", "claude"],
            ["shell-1", "shell-1"],
          ])
        }
        hookBadges={new Map([["shell-1", { label: "pre-tool-use", tone: "agent-hook" }]])}
      />,
    );

    expect(screen.getByText("pre-tool-use")).toBeTruthy();
    const badgeSlots = document.querySelectorAll(".tab-indicator-hook-badge");
    expect(badgeSlots).toHaveLength(1);
    expect(badgeSlots[0].classList.contains("tone-agent-hook")).toBe(true);
  });

  it("renders Yorishiro trigger badges with a distinct tone", () => {
    render(
      <TabIndicator
        state={state()}
        labels={
          new Map([
            ["default-session", "claude"],
            ["shell-1", "shell-1"],
          ])
        }
        hookBadges={
          new Map([
            [
              "default-session",
              {
                label: "trigger:session-opened",
                tone: "yorishiro",
                title: "Yorishiro trigger: session-opened",
              },
            ],
          ])
        }
      />,
    );

    const badge = screen.getByText("trigger:session-opened");
    expect(badge.classList.contains("tone-yorishiro")).toBe(true);
    expect(badge.getAttribute("title")).toBe("Yorishiro trigger: session-opened");
  });

  it("renders failure badges with a danger tone", () => {
    render(
      <TabIndicator
        state={state()}
        labels={
          new Map([
            ["default-session", "claude"],
            ["shell-1", "shell-1"],
          ])
        }
        hookBadges={new Map([["default-session", { label: "tool-failed", tone: "danger" }]])}
      />,
    );

    const badge = screen.getByText("tool-failed");
    expect(badge.classList.contains("tone-danger")).toBe(true);
  });

  it("marks the main tab for primary presentation", () => {
    render(
      <TabIndicator
        state={state()}
        labels={
          new Map([
            ["default-session", "claude"],
            ["shell-1", "shell-1"],
          ])
        }
      />,
    );

    expect(document.querySelector(".tab-indicator-item.is-main")).toBeTruthy();
  });

  it("marks a single main tab separately from multi-tab active state", () => {
    render(
      <TabIndicator
        state={{
          sessions: ["default-session"],
          activeSessionId: "default-session",
          mainSessionId: "default-session",
        }}
        labels={new Map([["default-session", "claude"]])}
      />,
    );

    const tabItem = document.querySelector(".tab-indicator-item");
    expect(tabItem?.classList.contains("is-main")).toBe(true);
    expect(tabItem?.classList.contains("is-single")).toBe(true);
    expect(tabItem?.classList.contains("active")).toBe(true);
  });

  it("calls onSelectSession when a tab is clicked", () => {
    const onSelectSession = vi.fn();

    render(
      <TabIndicator
        state={state()}
        labels={
          new Map([
            ["default-session", "claude"],
            ["shell-1", "shell-1"],
          ])
        }
        onSelectSession={onSelectSession}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /shell-1/ }));

    expect(onSelectSession).toHaveBeenCalledWith("shell-1");
  });

  it("calls onAddSession from the add button", () => {
    const onAddSession = vi.fn();

    render(
      <TabIndicator
        state={state()}
        labels={
          new Map([
            ["default-session", "claude"],
            ["shell-1", "shell-1"],
          ])
        }
        onAddSession={onAddSession}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New terminal tab" }));

    expect(onAddSession).toHaveBeenCalledTimes(1);
  });

  it("does not render a close button for the main tab", () => {
    render(
      <TabIndicator
        state={state()}
        labels={
          new Map([
            ["default-session", "claude"],
            ["shell-1", "shell-1"],
          ])
        }
        onCloseSession={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Close claude" })).toBeNull();
  });

  it("calls onCloseSession from shell tab close buttons", () => {
    const onCloseSession = vi.fn();

    render(
      <TabIndicator
        state={state()}
        labels={
          new Map([
            ["default-session", "claude"],
            ["shell-1", "shell-1"],
          ])
        }
        onCloseSession={onCloseSession}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close shell-1" }));

    expect(onCloseSession).toHaveBeenCalledWith("shell-1");
  });
});

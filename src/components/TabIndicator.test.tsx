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
    expect(screen.queryByText("run")).toBeNull();
    expect(screen.queryByText("failed")).toBeNull();
    expect(screen.queryByText("◆")).toBeNull();
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

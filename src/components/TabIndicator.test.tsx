// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
  it("does not render with a single session", () => {
    const { container } = render(
      <TabIndicator
        state={{
          sessions: ["default-session"],
          activeSessionId: "default-session",
          mainSessionId: "default-session",
        }}
        labels={new Map([["default-session", "claude"]])}
      />,
    );

    expect(container.textContent).toBe("");
  });

  it("renders status badges and unread marker", () => {
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

    expect(screen.getByText(/● claude/)).toBeTruthy();
    expect(screen.getByText("run")).toBeTruthy();
    expect(screen.getByText(/◆ shell-1/)).toBeTruthy();
    expect(screen.getByText("failed")).toBeTruthy();
    expect(screen.getByText(/◆ shell-1/).getAttribute("title")).toBe("Claude: Permission needed");
  });
});

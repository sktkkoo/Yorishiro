import type { DispatchEvent, SyntheticEvent } from "@charminal/sdk";
import { describe, expect, it } from "vitest";
import type { SessionTabState } from "../runtime/session-tabs/types";
import { deriveSessionTabMetadataBadge } from "./session-tab-metadata-badges";

const state: SessionTabState = {
  sessions: ["default-session", "shell-1"],
  activeSessionId: "shell-1",
  mainSessionId: "default-session",
};

const systemSynthetic = (name: string, payload: unknown = undefined): SyntheticEvent => ({
  kind: "synthetic",
  source: { type: "system", packId: "charminal:session-tabs" },
  name,
  payload,
  timestamp: 100,
});

describe("deriveSessionTabMetadataBadge", () => {
  it("shows system synthetic events and targets payload sessionId when present", () => {
    expect(
      deriveSessionTabMetadataBadge(
        systemSynthetic("session-opened", { sessionId: "shell-2" }),
        state,
      ),
    ).toEqual({
      sessionId: "shell-2",
      badge: {
        label: "trigger:session-opened",
        tone: "charminal",
        title: "Charminal trigger: charminal:session-tabs/session-opened",
      },
    });
  });

  it("falls back to the active session for badge-worthy events without a sessionId", () => {
    expect(
      deriveSessionTabMetadataBadge(systemSynthetic("pomodoro:session-completed"), state),
    ).toMatchObject({
      sessionId: "shell-1",
      badge: { label: "trigger:pomodoro:session-completed" },
    });
  });

  it("hides persona synthetic events", () => {
    expect(
      deriveSessionTabMetadataBadge(
        {
          ...systemSynthetic("deploy-failed"),
          source: { type: "persona", packId: "clai" },
        },
        state,
      ),
    ).toBeNull();
  });

  it("shows only notable hook-signal events", () => {
    expect(
      deriveSessionTabMetadataBadge(
        {
          kind: "hook-signal",
          signal: {
            name: "post-tool-failure",
            payload: { tool_name: "Bash", sessionId: "shell-2" },
          },
          timestamp: 100,
        },
        state,
      ),
    ).toEqual({
      sessionId: "shell-2",
      badge: {
        label: "tool-failed",
        tone: "agent-hook",
        title: "Agent hook: post-tool-failure",
      },
    });

    expect(
      deriveSessionTabMetadataBadge(
        {
          kind: "hook-signal",
          signal: { name: "pre-tool-use", payload: { tool_name: "Read" } },
          timestamp: 100,
        },
        state,
      ),
    ).toBeNull();
  });

  it("shows notable loop lifecycle phases", () => {
    expect(
      deriveSessionTabMetadataBadge(
        { kind: "loop-lifecycle", phase: "blocked-on-approval", agent: "codex", timestamp: 100 },
        state,
      ),
    ).toMatchObject({
      sessionId: "shell-1",
      badge: {
        label: "loop:blocked",
        tone: "charminal",
        title: "Loop lifecycle: blocked-on-approval (codex)",
      },
    });

    expect(
      deriveSessionTabMetadataBadge(
        { kind: "loop-lifecycle", phase: "progress-milestone", agent: null, timestamp: 100 },
        state,
      )?.badge.label,
    ).toBe("loop:milestone");
    expect(
      deriveSessionTabMetadataBadge(
        { kind: "loop-lifecycle", phase: "failed", agent: "claude", timestamp: 100 },
        state,
      )?.badge.label,
    ).toBe("loop:failed");
    expect(
      deriveSessionTabMetadataBadge(
        { kind: "loop-lifecycle", phase: "completed", agent: "claude", timestamp: 100 },
        state,
      )?.badge.label,
    ).toBe("loop:done");
  });

  it("hides noisy lifecycle and derived events", () => {
    const hidden: DispatchEvent[] = [
      { kind: "pty-output", text: "hello", timestamp: 100 },
      { kind: "user-input", text: "hello", timestamp: 100 },
      { kind: "idle", durationMs: 30000, timestamp: 100 },
      { kind: "tool-activity", activity: "running", timestamp: 100 },
      { kind: "window", change: "resize", timestamp: 100 },
      { kind: "scene-change", fromId: null, toId: "simple-room", timestamp: 100 },
      { kind: "charm-command", command: "help", timestamp: 100 },
      { kind: "loop-lifecycle", phase: "started", agent: "codex", timestamp: 100 },
      { kind: "loop-lifecycle", phase: "iterating", agent: "codex", timestamp: 100 },
    ];

    for (const event of hidden) {
      expect(deriveSessionTabMetadataBadge(event, state)).toBeNull();
    }
  });
});

// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { AgentDescriptor } from "../../bindings/tauri-commands";
import {
  consumePendingRealtimeStart,
  isVoiceEntryAvailable,
  markPendingRealtimeStart,
  PENDING_REALTIME_START_KEY,
  resolveVoiceEntryAction,
} from "./voice-entry";

const capabilities = (realtimeConversation: boolean) => ({
  personaOverlay: true,
  mcpInjection: true,
  plugins: true,
  lifecycleHooks: true,
  sessionResume: true,
  realtimeConversation,
});

const agent = (id: string, realtimeConversation: boolean, binaryName = id): AgentDescriptor => ({
  id,
  displayName: id === "codex" ? "Codex" : "Claude Code",
  binaryName,
  capabilities: capabilities(realtimeConversation),
  commandSyntax: { prefix: "/", separator: ":" },
});

describe("resolveVoiceEntryAction", () => {
  const agents = [agent("claude", false, "claude"), agent("codex", true, "codex")];

  it("preserves the existing realtime path for the active Codex agent", async () => {
    const resolveCommandPath = vi.fn();
    await expect(
      resolveVoiceEntryAction({ activeAgent: "codex", agents, resolveCommandPath }),
    ).resolves.toEqual({ kind: "start" });
    expect(resolveCommandPath).not.toHaveBeenCalled();
  });

  it("offers an explicit switch when the realtime agent is configured", async () => {
    await expect(
      resolveVoiceEntryAction({
        activeAgent: "claude",
        agents,
        resolveCommandPath: vi.fn().mockResolvedValue("/usr/local/bin/codex"),
      }),
    ).resolves.toMatchObject({ kind: "confirm-switch", agent: { id: "codex" } });
  });

  it("offers setup when the realtime agent binary is missing", async () => {
    await expect(
      resolveVoiceEntryAction({
        activeAgent: "claude",
        agents,
        resolveCommandPath: vi.fn().mockResolvedValue(null),
      }),
    ).resolves.toMatchObject({ kind: "setup", agent: { id: "codex" } });
  });

  it("offers setup when no registered adapter supports realtime", async () => {
    await expect(
      resolveVoiceEntryAction({
        activeAgent: "claude",
        agents: [agent("claude", false)],
        resolveCommandPath: vi.fn(),
      }),
    ).resolves.toEqual({ kind: "setup", agent: null });
  });
});

describe("isVoiceEntryAvailable", () => {
  it("keeps the Main Agent voice entry visible while a shell tab is selected", () => {
    expect(isVoiceEntryAvailable()).toBe(true);
  });
});

describe("pending realtime start", () => {
  it("is a one-shot marker across the agent-switch reload", () => {
    const storage = window.sessionStorage;
    storage.removeItem(PENDING_REALTIME_START_KEY);
    markPendingRealtimeStart(storage);
    expect(consumePendingRealtimeStart(storage)).toBe(true);
    expect(consumePendingRealtimeStart(storage)).toBe(false);
  });
});

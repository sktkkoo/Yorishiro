// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { AgentDescriptor } from "../../bindings/tauri-commands";
import {
  consumePendingContinuityConversation,
  consumePendingRealtimeStart,
  isVoiceEntryAvailable,
  markPendingContinuityConversation,
  markPendingRealtimeStart,
  PENDING_REALTIME_START_KEY,
  resolveVoiceEntryAction,
  runVoiceEntryPreflight,
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

describe("runVoiceEntryPreflight", () => {
  const agents = [agent("claude", false), agent("codex", true)];
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((finish) => {
      resolve = finish;
    });
    return { promise, resolve };
  }

  it.each([
    ["codex", "/usr/local/bin/codex"],
    ["claude", "/usr/local/bin/codex"],
    ["claude", null],
  ] as const)("does not publish the late %s/%s decision after discovery is cancelled", async (activeAgent, commandPath) => {
    const discovery = deferred<readonly AgentDescriptor[]>();
    const controller = new AbortController();
    const resolveCommandPath = vi.fn().mockResolvedValue(commandPath);
    const onStart = vi.fn().mockResolvedValue(undefined);
    const onOffer = vi.fn();
    const pending = runVoiceEntryPreflight({
      activeAgent,
      listAgents: () => discovery.promise,
      resolveCommandPath,
      signal: controller.signal,
      onStart,
      onOffer,
    });
    controller.abort();
    discovery.resolve(agents);
    await pending;
    expect(resolveCommandPath).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
    expect(onOffer).not.toHaveBeenCalled();
  });

  it.each([
    ["codex", "/usr/local/bin/codex", "start"],
    ["claude", "/usr/local/bin/codex", "confirm-switch"],
    ["claude", null, "setup"],
  ] as const)("preserves the uncancelled %s/%s entry decision", async (activeAgent, commandPath, kind) => {
    const onStart = vi.fn().mockResolvedValue(undefined);
    const onOffer = vi.fn();
    await runVoiceEntryPreflight({
      activeAgent,
      listAgents: async () => agents,
      resolveCommandPath: vi.fn().mockResolvedValue(commandPath),
      signal: new AbortController().signal,
      onStart,
      onOffer,
    });
    if (kind === "start") {
      expect(onStart).toHaveBeenCalledOnce();
      expect(onOffer).not.toHaveBeenCalled();
    } else {
      expect(onOffer).toHaveBeenCalledExactlyOnceWith({ kind, agent: agents[1] });
      expect(onStart).not.toHaveBeenCalled();
    }
  });

  it.each([
    null,
    "/usr/local/bin/codex",
  ])("discards cancelled setup/switch decisions after binary lookup resolves to %s", async (path) => {
    const lookup = deferred<string | null>();
    const controller = new AbortController();
    const onStart = vi.fn().mockResolvedValue(undefined);
    const onOffer = vi.fn();
    const resolveCommandPath = vi.fn(() => lookup.promise);
    const pending = runVoiceEntryPreflight({
      activeAgent: "claude",
      listAgents: async () => agents,
      resolveCommandPath,
      signal: controller.signal,
      onStart,
      onOffer,
    });
    await vi.waitFor(() => expect(resolveCommandPath).toHaveBeenCalledOnce());
    controller.abort();
    lookup.resolve(path);
    await pending;
    expect(onStart).not.toHaveBeenCalled();
    expect(onOffer).not.toHaveBeenCalled();
  });

  it("allows a new attempt while an older cancelled discovery is still pending", async () => {
    const discovery = deferred<readonly AgentDescriptor[]>();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const onStart = vi.fn().mockResolvedValue(undefined);
    const onOffer = vi.fn();
    const options = {
      activeAgent: "codex",
      resolveCommandPath: vi.fn().mockResolvedValue("/usr/local/bin/codex"),
      onStart,
      onOffer,
    };
    const first = runVoiceEntryPreflight({
      ...options,
      listAgents: () => discovery.promise,
      signal: firstController.signal,
    });
    firstController.abort();
    await runVoiceEntryPreflight({
      ...options,
      listAgents: async () => agents,
      signal: secondController.signal,
    });
    expect(onStart).toHaveBeenCalledOnce();
    discovery.resolve(agents);
    await first;
    expect(onStart).toHaveBeenCalledOnce();
    expect(onOffer).not.toHaveBeenCalled();
  });
});

describe("pending realtime start", () => {
  it("restores companion context once without changing the ordinary voice entry", () => {
    const storage = window.sessionStorage;
    expect(consumePendingContinuityConversation(storage)).toBe(false);
    markPendingContinuityConversation(storage);
    expect(consumePendingContinuityConversation(storage)).toBe(true);
    expect(consumePendingContinuityConversation(storage)).toBe(false);
    expect(consumePendingRealtimeStart(storage)).toBe(true);
    expect(consumePendingRealtimeStart(storage)).toBe(false);
    markPendingRealtimeStart(storage);
    expect(consumePendingContinuityConversation(storage)).toBe(false);
    expect(consumePendingRealtimeStart(storage)).toBe(true);
  });
  it("is a one-shot marker across the agent-switch reload", () => {
    const storage = window.sessionStorage;
    storage.removeItem(PENDING_REALTIME_START_KEY);
    markPendingRealtimeStart(storage);
    expect(consumePendingRealtimeStart(storage)).toBe(true);
    expect(consumePendingRealtimeStart(storage)).toBe(false);
  });
});

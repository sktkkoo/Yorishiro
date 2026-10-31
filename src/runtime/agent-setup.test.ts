import { describe, expect, it, vi } from "vitest";
import {
  type AgentDetectionDeps,
  type DetectedAgent,
  detectInstalledAgents,
  hasSavedAgentChoice,
  resolveAgentStartup,
} from "./agent-setup";

const agent = (id: string, path: string | null, error?: string): DetectedAgent => ({
  id,
  displayName: id,
  binaryName: id,
  path,
  ...(error === undefined ? {} : { error }),
});

describe("detectInstalledAgents", () => {
  const agents = [
    { id: "claude", displayName: "Claude Code", binaryName: "claude" },
    { id: "codex", displayName: "Codex", binaryName: "codex" },
    { id: "opencode", displayName: "OpenCode", binaryName: "opencode-custom" },
  ];

  it("detects every registered adapter using its binary name", async () => {
    const resolveCommandPath = vi
      .fn<AgentDetectionDeps["resolveCommandPath"]>()
      .mockImplementation(async ({ command }) =>
        command === "claude" ? null : `/usr/local/bin/${command}`,
      );
    const result = await detectInstalledAgents({
      listSupportedAgents: async () => agents,
      resolveCommandPath,
    });

    expect(result).toEqual([
      { ...agents[0], path: null },
      { ...agents[1], path: "/usr/local/bin/codex" },
      { ...agents[2], path: "/usr/local/bin/opencode-custom" },
    ]);
    expect(resolveCommandPath).toHaveBeenCalledWith({ command: "opencode-custom" });
  });

  it("preserves a permission error without discarding other detection results", async () => {
    const result = await detectInstalledAgents({
      listSupportedAgents: async () => agents,
      resolveCommandPath: async ({ command }) => {
        if (command === "claude") throw new Error("Permission denied");
        if (command === "codex") return Promise.reject("IPC unavailable");
        return "/opt/homebrew/bin/opencode-custom";
      },
    });

    expect(result).toEqual([
      { ...agents[0], path: null, error: "Permission denied" },
      { ...agents[1], path: null, error: "IPC unavailable" },
      { ...agents[2], path: "/opt/homebrew/bin/opencode-custom" },
    ]);
  });

  it("propagates registry failures instead of reporting no installed agents", async () => {
    const resolveCommandPath = vi.fn();
    await expect(
      detectInstalledAgents({
        listSupportedAgents: async () => {
          throw new Error("Registry unavailable");
        },
        resolveCommandPath,
      }),
    ).rejects.toThrow("Registry unavailable");
    expect(resolveCommandPath).not.toHaveBeenCalled();
  });
});

describe("hasSavedAgentChoice", () => {
  it.each([
    null,
    "0",
    "1",
  ])("keeps an explicitly configured agent regardless of marker %s", (savedChoiceMarker) => {
    expect(
      hasSavedAgentChoice({
        hasConfiguredChoice: true,
        savedChoiceMarker,
        legacyHealthSeen: false,
      }),
    ).toBe(true);
  });

  it("preserves legacy users whose default agent was omitted from serialized config", () => {
    expect(
      hasSavedAgentChoice({
        hasConfiguredChoice: false,
        savedChoiceMarker: null,
        legacyHealthSeen: true,
      }),
    ).toBe(true);
  });

  it("does not treat a skipped first-run health check as an agent choice", () => {
    expect(
      hasSavedAgentChoice({
        hasConfiguredChoice: false,
        savedChoiceMarker: "0",
        legacyHealthSeen: true,
      }),
    ).toBe(false);
  });

  it("preserves an actual choice before the health check was shown", () => {
    expect(
      hasSavedAgentChoice({
        hasConfiguredChoice: false,
        savedChoiceMarker: "1",
        legacyHealthSeen: false,
      }),
    ).toBe(true);
  });

  it("leaves a new installation unchosen", () => {
    expect(
      hasSavedAgentChoice({
        hasConfiguredChoice: false,
        savedChoiceMarker: null,
        legacyHealthSeen: false,
      }),
    ).toBe(false);
  });
});

describe("resolveAgentStartup", () => {
  it.each([
    "claude",
    "codex",
    "opencode",
  ])("automatically chooses the only installed adapter, including %s", (installedId) => {
    const agents = ["claude", "codex", "opencode"].map((id) =>
      agent(id, id === installedId ? `/bin/${id}` : null),
    );
    expect(
      resolveAgentStartup({ agents, preferredAgent: "claude", hasSavedChoice: false }),
    ).toEqual({ kind: "ready", agentId: installedId, automatic: true });
  });

  it.each([
    "claude",
    "codex",
  ])("starts the preferred %s without setup when both agents are installed on first launch", (preferredAgent) => {
    expect(
      resolveAgentStartup({
        agents: [agent("claude", "/bin/claude"), agent("codex", "/bin/codex")],
        preferredAgent,
        hasSavedChoice: false,
      }),
    ).toEqual({ kind: "ready", agentId: preferredAgent, automatic: true });
  });

  it("prefers the default Codex when multiple agents are installed without a preference", () => {
    expect(
      resolveAgentStartup({
        agents: [agent("claude", "/bin/claude"), agent("codex", "/bin/codex")],
        preferredAgent: "",
        hasSavedChoice: false,
      }),
    ).toEqual({ kind: "ready", agentId: "codex", automatic: true });
  });

  it("uses the first available adapter when neither the preference nor Codex is installed", () => {
    expect(
      resolveAgentStartup({
        agents: [agent("opencode", "/bin/opencode"), agent("claude", "/bin/claude")],
        preferredAgent: "removed-adapter",
        hasSavedChoice: false,
      }),
    ).toEqual({ kind: "ready", agentId: "opencode", automatic: true });
  });

  it("preserves the saved Claude choice when Codex is also installed", () => {
    expect(
      resolveAgentStartup({
        agents: [agent("codex", "/bin/codex"), agent("claude", "/bin/claude")],
        preferredAgent: "claude",
        hasSavedChoice: true,
      }),
    ).toEqual({ kind: "ready", agentId: "claude", automatic: false });
  });

  it.each([
    { name: "empty registry", agents: [] },
    { name: "missing executable", agents: [agent("claude", null)] },
    { name: "empty path", agents: [agent("claude", " ")] },
  ])("shows setup when there is no usable executable: $name", ({ agents }) => {
    expect(
      resolveAgentStartup({ agents, preferredAgent: "claude", hasSavedChoice: false }),
    ).toEqual({ kind: "setup", reason: "missing" });
  });

  it("keeps a saved installed choice even when another probe fails", () => {
    expect(
      resolveAgentStartup({
        agents: [agent("claude", null, "Permission denied"), agent("codex", "/bin/codex")],
        preferredAgent: "codex",
        hasSavedChoice: true,
      }),
    ).toEqual({ kind: "ready", agentId: "codex", automatic: false });
  });

  it.each([
    "claude",
    "removed-adapter",
  ])("automatically replaces an unavailable saved choice: %s", (preferredAgent) => {
    expect(
      resolveAgentStartup({
        agents: [agent("claude", null), agent("codex", "/bin/codex")],
        preferredAgent,
        hasSavedChoice: true,
      }),
    ).toEqual({ kind: "ready", agentId: "codex", automatic: true });
  });

  it("uses another installed agent when detection of the saved choice fails", () => {
    expect(
      resolveAgentStartup({
        agents: [agent("claude", null, "Permission denied"), agent("codex", "/bin/codex")],
        preferredAgent: "claude",
        hasSavedChoice: true,
      }),
    ).toEqual({ kind: "ready", agentId: "codex", automatic: true });
  });

  it("starts a known installed agent despite another discovery error on first launch", () => {
    expect(
      resolveAgentStartup({
        agents: [agent("claude", null, "Permission denied"), agent("codex", "/bin/codex")],
        preferredAgent: "claude",
        hasSavedChoice: false,
      }),
    ).toEqual({ kind: "ready", agentId: "codex", automatic: true });
  });

  it.each([
    false,
    true,
  ])("shows detection errors when no executable was verified, saved choice: %s", (hasSavedChoice) => {
    expect(
      resolveAgentStartup({
        agents: [agent("claude", null, "Permission denied"), agent("codex", null)],
        preferredAgent: "claude",
        hasSavedChoice,
      }),
    ).toEqual({ kind: "setup", reason: "detection-error" });
  });
});

/**
 * Bundled profile と resolver の動作を固める test。
 */

import { describe, expect, it } from "vitest";
import { KNOWN_AGENT_IDS } from "../user-pack-loader/config";
import {
  getBundledProfile,
  listAvailableProfiles,
  listBundledProfiles,
  resolveEffectiveAgent,
  resolveProfile,
} from "./profiles";
import type { SessionProfile } from "./types";

describe("listBundledProfiles", () => {
  it("returns shell / claude / codex / opencode in stable order", () => {
    const ids = listBundledProfiles().map((p) => p.id);
    expect(ids).toEqual(["shell", "claude", "codex", "opencode"]);
  });

  it("shell profile has kind=shell and agent=null", () => {
    const shell = listBundledProfiles().find((p) => p.id === "shell");
    expect(shell?.kind).toBe("shell");
    expect(shell?.agent).toBeNull();
    expect(shell?.integration).toBe(true);
  });

  it("claude profile has kind=agent and agent=claude", () => {
    const claude = listBundledProfiles().find((p) => p.id === "claude");
    expect(claude?.kind).toBe("agent");
    expect(claude?.agent).toBe("claude");
  });

  it("opencode profile has kind=agent and agent=opencode", () => {
    const opencode = listBundledProfiles().find((p) => p.id === "opencode");
    expect(opencode?.kind).toBe("agent");
    expect(opencode?.agent).toBe("opencode");
  });
});

describe("getBundledProfile", () => {
  it("returns the bundled profile for known id", () => {
    expect(getBundledProfile("claude")?.agent).toBe("claude");
    expect(getBundledProfile("codex")?.agent).toBe("codex");
    expect(getBundledProfile("opencode")?.agent).toBe("opencode");
    expect(getBundledProfile("shell")?.kind).toBe("shell");
  });

  it("returns null for unknown id", () => {
    expect(getBundledProfile("phantom")).toBeNull();
  });
});

describe("agent id sync", () => {
  it("keeps bundled agent profiles aligned with config validation", () => {
    const bundledAgentIds = listBundledProfiles()
      .map((profile) => profile.agent)
      .filter((agent): agent is string => agent !== null);
    expect(new Set(bundledAgentIds)).toEqual(KNOWN_AGENT_IDS);
  });
});

describe("resolveEffectiveAgent", () => {
  const codexProfile: SessionProfile = {
    id: "codex",
    kind: "agent",
    command: null,
    args: [],
    env: {},
    cwd: null,
    agent: "codex",
    integration: true,
  };

  it("falls back to terminalAgent when defaultProfile is null", () => {
    expect(
      resolveEffectiveAgent({ terminalAgent: "claude", defaultProfile: null, profiles: [] }),
    ).toBe("claude");
  });

  it("prefers the agent of a bundled defaultProfile over terminalAgent", () => {
    // terminalAgent は legacy default "claude" のままでも、defaultProfile=codex が勝つ。
    expect(
      resolveEffectiveAgent({ terminalAgent: "claude", defaultProfile: "codex", profiles: [] }),
    ).toBe("codex");
  });

  it("prefers the agent of a user defaultProfile", () => {
    expect(
      resolveEffectiveAgent({
        terminalAgent: "claude",
        defaultProfile: "codex",
        profiles: [{ ...codexProfile, id: "codex", agent: "opencode" }],
      }),
    ).toBe("opencode");
  });

  it("falls back to terminalAgent when defaultProfile is a shell profile", () => {
    expect(
      resolveEffectiveAgent({ terminalAgent: "codex", defaultProfile: "shell", profiles: [] }),
    ).toBe("codex");
  });

  it("falls back to terminalAgent when defaultProfile id is unresolvable", () => {
    expect(
      resolveEffectiveAgent({ terminalAgent: "claude", defaultProfile: "phantom", profiles: [] }),
    ).toBe("claude");
  });
});

describe("resolveProfile", () => {
  const userProfile: SessionProfile = {
    id: "shell",
    kind: "shell",
    command: "/opt/homebrew/bin/fish",
    args: [],
    env: {},
    cwd: null,
    agent: null,
    integration: true,
  };

  it("returns user profile when it overrides bundled by id", () => {
    const resolved = resolveProfile("shell", [userProfile]);
    expect(resolved?.command).toBe("/opt/homebrew/bin/fish");
  });

  it("falls back to bundled when user has no matching id", () => {
    const resolved = resolveProfile("claude", [userProfile]);
    expect(resolved?.agent).toBe("claude");
  });

  it("returns null when neither user nor bundled has the id", () => {
    expect(resolveProfile("phantom", [userProfile])).toBeNull();
  });

  it("works with empty user profiles", () => {
    expect(resolveProfile("shell", [])?.kind).toBe("shell");
  });
});

describe("listAvailableProfiles", () => {
  it("returns all bundled when user has none", () => {
    const ids = listAvailableProfiles([]).map((p) => p.id);
    expect(ids).toEqual(["shell", "claude", "codex", "opencode"]);
  });

  it("user profile shadows bundled with same id", () => {
    const userFishOverride: SessionProfile = {
      id: "shell",
      kind: "shell",
      command: "/opt/homebrew/bin/fish",
      args: [],
      env: {},
      cwd: null,
      agent: null,
      integration: true,
    };
    const list = listAvailableProfiles([userFishOverride]);
    expect(list.map((p) => p.id)).toEqual(["shell", "claude", "codex", "opencode"]);
    expect(list[0].command).toBe("/opt/homebrew/bin/fish");
  });

  it("user profile with new id appears alongside bundled", () => {
    const nixDev: SessionProfile = {
      id: "nix-dev",
      kind: "shell",
      command: "nix-shell",
      args: ["--command", "zsh"],
      env: {},
      cwd: null,
      agent: null,
      integration: true,
    };
    const ids = listAvailableProfiles([nixDev]).map((p) => p.id);
    expect(ids).toEqual(["nix-dev", "shell", "claude", "codex", "opencode"]);
  });
});

/**
 * Bundled profile と resolver の動作を固める test。
 */

import { describe, expect, it } from "vitest";
import {
  getBundledProfile,
  listAvailableProfiles,
  listBundledProfiles,
  resolveProfile,
} from "./profiles";
import type { SessionProfile } from "./types";

describe("listBundledProfiles", () => {
  it("returns shell / claude / codex in stable order", () => {
    const ids = listBundledProfiles().map((p) => p.id);
    expect(ids).toEqual(["shell", "claude", "codex"]);
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
});

describe("getBundledProfile", () => {
  it("returns the bundled profile for known id", () => {
    expect(getBundledProfile("claude")?.agent).toBe("claude");
    expect(getBundledProfile("codex")?.agent).toBe("codex");
    expect(getBundledProfile("shell")?.kind).toBe("shell");
  });

  it("returns null for unknown id", () => {
    expect(getBundledProfile("phantom")).toBeNull();
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
    expect(ids).toEqual(["shell", "claude", "codex"]);
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
    expect(list.map((p) => p.id)).toEqual(["shell", "claude", "codex"]);
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
    expect(ids).toEqual(["nix-dev", "shell", "claude", "codex"]);
  });
});

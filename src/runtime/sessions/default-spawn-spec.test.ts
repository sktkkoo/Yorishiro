import { describe, expect, it } from "vitest";

import { spawnSpecFromDefaultProfile, withAgentRuntimeFields } from "./default-spawn-spec";
import type { SessionProfile } from "./types";

const shellProfile: SessionProfile = {
  id: "shell",
  kind: "shell",
  command: null,
  args: [],
  env: {},
  cwd: null,
  agent: null,
  integration: true,
};

const opencodeProfile: SessionProfile = {
  id: "opencode",
  kind: "agent",
  command: null,
  args: [],
  env: {},
  cwd: null,
  agent: "opencode",
  integration: true,
};

describe("spawnSpecFromDefaultProfile", () => {
  it("keeps shell profiles as shell spawn specs", () => {
    expect(spawnSpecFromDefaultProfile(shellProfile)).toEqual({
      kind: "shell",
      command: null,
      integration: true,
    });
  });

  it("turns bundled agent profiles into agent spawn specs", () => {
    expect(spawnSpecFromDefaultProfile(opencodeProfile)).toEqual({
      kind: "agent",
      agent: "opencode",
      command: null,
    });
  });
});

describe("withAgentRuntimeFields", () => {
  it("adds runtime prompt and plugin dir to agent specs", () => {
    expect(
      withAgentRuntimeFields(
        { kind: "agent", agent: "opencode", command: null },
        "resident prompt",
        "/tmp/charminal-plugin",
      ),
    ).toEqual({
      kind: "agent",
      agent: "opencode",
      command: null,
      systemPrompt: "resident prompt",
      pluginDir: "/tmp/charminal-plugin",
    });
  });

  it("does not add agent fields to shell specs", () => {
    expect(
      withAgentRuntimeFields(
        { kind: "shell", command: null, integration: true },
        "resident prompt",
        "/tmp/charminal-plugin",
      ),
    ).toEqual({ kind: "shell", command: null, integration: true });
  });
});

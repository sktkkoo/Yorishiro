import { describe, expect, it } from "vitest";

import {
  spawnSpecFromDefaultProfile,
  withAgentResumePolicy,
  withAgentResumeSessionId,
  withAgentRuntimeFields,
} from "./default-spawn-spec";
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
        "/tmp/yorishiro-plugin",
      ),
    ).toEqual({
      kind: "agent",
      agent: "opencode",
      command: null,
      systemPrompt: "resident prompt",
      pluginDir: "/tmp/yorishiro-plugin",
    });
  });

  it("does not add agent fields to shell specs", () => {
    expect(
      withAgentRuntimeFields(
        { kind: "shell", command: null, integration: true },
        "resident prompt",
        "/tmp/yorishiro-plugin",
      ),
    ).toEqual({ kind: "shell", command: null, integration: true });
  });
});

describe("withAgentResumePolicy", () => {
  it("can disable agent resume for a fresh persona session", () => {
    expect(withAgentResumePolicy({ kind: "agent", agent: "claude", command: null }, false)).toEqual(
      {
        kind: "agent",
        agent: "claude",
        command: null,
        resume: false,
        resumeSessionId: null,
      },
    );
  });

  it("clears an exact resume target when preparing a fresh session", () => {
    expect(
      withAgentResumePolicy(
        {
          kind: "agent",
          agent: "codex",
          resume: true,
          resumeSessionId: "old-session-id",
        },
        false,
      ),
    ).toEqual({
      kind: "agent",
      agent: "codex",
      resume: false,
      resumeSessionId: null,
    });
  });

  it("does not add resume policy to shell specs", () => {
    expect(
      withAgentResumePolicy({ kind: "shell", command: null, integration: true }, false),
    ).toEqual({ kind: "shell", command: null, integration: true });
  });
});

describe("withAgentResumeSessionId", () => {
  it("targets one exact agent conversation and enables resume", () => {
    expect(
      withAgentResumeSessionId({ kind: "agent", agent: "codex", resume: false }, "0198-session-id"),
    ).toEqual({
      kind: "agent",
      agent: "codex",
      resume: true,
      resumeSessionId: "0198-session-id",
    });
  });

  it("does not add provider resume fields to shell specs", () => {
    expect(
      withAgentResumeSessionId({ kind: "shell", command: null, integration: true }, "ignored"),
    ).toEqual({ kind: "shell", command: null, integration: true });
  });
});

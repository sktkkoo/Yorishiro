import { describe, expect, it } from "vitest";
import {
  getAgentRuntimePolicy,
  resolveInterruptProtectionModeForSpawnSpec,
} from "./agent-runtime-policy";

describe("agent runtime policy", () => {
  it("allows Claude Code's first Ctrl+C but suppresses repeated Ctrl+C", () => {
    expect(getAgentRuntimePolicy("claude").interruptProtectionMode).toBe("repeated");
  });

  it("suppresses the first Ctrl+C for Codex and OpenCode", () => {
    expect(getAgentRuntimePolicy("codex").interruptProtectionMode).toBe("all");
    expect(getAgentRuntimePolicy("opencode").interruptProtectionMode).toBe("all");
  });

  it("defaults unknown agents to the non-exiting Ctrl+C policy", () => {
    expect(getAgentRuntimePolicy("custom-agent").interruptProtectionMode).toBe("all");
  });

  it("does not protect shell specs", () => {
    expect(
      resolveInterruptProtectionModeForSpawnSpec({
        kind: "shell",
        command: null,
        integration: true,
      }),
    ).toBe("none");
  });

  it("resolves interrupt protection from agent spawn specs", () => {
    expect(
      resolveInterruptProtectionModeForSpawnSpec({
        kind: "agent",
        agent: "opencode",
        command: null,
      }),
    ).toBe("all");
  });
});

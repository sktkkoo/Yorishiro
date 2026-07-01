import type { SpawnSpec } from "../../bindings/tauri-commands";
import type { InterruptProtectionMode } from "../terminal-runtime";

export interface AgentRuntimePolicy {
  readonly interruptProtectionMode: InterruptProtectionMode;
}

const DEFAULT_AGENT_RUNTIME_POLICY: AgentRuntimePolicy = {
  interruptProtectionMode: "all",
};

const AGENT_RUNTIME_POLICIES: Readonly<Record<string, AgentRuntimePolicy>> = {
  claude: {
    interruptProtectionMode: "repeated",
  },
  codex: {
    interruptProtectionMode: "all",
  },
  opencode: {
    interruptProtectionMode: "all",
  },
};

export function getAgentRuntimePolicy(agent: string): AgentRuntimePolicy {
  return AGENT_RUNTIME_POLICIES[agent] ?? DEFAULT_AGENT_RUNTIME_POLICY;
}

export function resolveInterruptProtectionModeForSpawnSpec(
  spec: SpawnSpec,
): InterruptProtectionMode {
  if (spec.kind !== "agent") return "none";
  return getAgentRuntimePolicy(spec.agent).interruptProtectionMode;
}

import type { SpawnSpec } from "../../bindings/tauri-commands";
import type { SessionProfile } from "./types";

export function spawnSpecFromDefaultProfile(profile: SessionProfile | null): SpawnSpec | null {
  if (profile === null) return null;
  if (profile.kind === "shell") {
    return {
      kind: "shell",
      command: profile.command,
      integration: profile.integration,
    };
  }
  if (profile.agent === null) return null;
  return {
    kind: "agent",
    agent: profile.agent,
    command: profile.command,
  };
}

export function withAgentRuntimeFields(
  spec: SpawnSpec,
  systemPrompt: string | null,
  pluginDir: string | null,
): SpawnSpec {
  if (spec.kind !== "agent") return spec;
  return {
    ...spec,
    systemPrompt,
    pluginDir,
  };
}

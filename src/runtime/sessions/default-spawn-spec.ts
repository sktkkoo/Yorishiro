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

export function withAgentResumePolicy(spec: SpawnSpec, resume: boolean): SpawnSpec {
  if (spec.kind !== "agent") return spec;
  return resume ? { ...spec, resume: true } : { ...spec, resume: false, resumeSessionId: null };
}

export function withAgentResumeSessionId(spec: SpawnSpec, sessionId: string): SpawnSpec {
  if (spec.kind !== "agent") return spec;
  return { ...spec, resume: true, resumeSessionId: sessionId };
}

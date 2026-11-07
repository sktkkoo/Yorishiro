import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

const CHECKS = {
  node: { node_supported: "ok", node_unsupported: "invalid" },
  configuration: {
    configuration_valid: "ok",
    configuration_invalid: "invalid",
    configuration_blocked: "blocked",
  },
  dependencies: {
    dependencies_available: "ok",
    dependencies_missing: "missing",
    dependencies_invalid: "invalid",
    dependencies_blocked: "blocked",
  },
  model: { model_available: "ok", model_unavailable: "missing", model_blocked: "blocked" },
  authentication: {
    authentication_present: "ok",
    authentication_missing: "missing",
    authentication_invalid: "invalid",
    authentication_blocked: "blocked",
  },
} as const;

type CheckName = keyof typeof CHECKS;
type CheckStatus = "ok" | "missing" | "invalid" | "blocked";
interface PiCheck {
  readonly name: CheckName;
  readonly status: CheckStatus;
  readonly code: string;
}
export interface PiDiagnostics {
  readonly protocol: 1;
  readonly ready: boolean;
  readonly checks: readonly PiCheck[];
}
const FAILURES = [
  "configuration_missing",
  "configuration_invalid",
  "node_unavailable",
  "workspace_unavailable",
  "diagnostic_unavailable",
  "diagnostic_invalid",
  "diagnostic_timeout",
] as const;
type Failure = (typeof FAILURES)[number];
export type PiDiagnosticOutcome =
  | { readonly ok: true; readonly diagnostics: PiDiagnostics }
  | { readonly ok: false; readonly code: Failure };

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && present.every((key) => keys.includes(key));
}
const hasOwn = (value: object, key: PropertyKey) =>
  Object.getOwnPropertyDescriptor(value, key) !== undefined;

/** Only known status tokens cross into UI state. No diagnostic text is trusted. */
export function parsePiDiagnostics(value: unknown): PiDiagnostics | null {
  if (
    !object(value) ||
    !exactKeys(value, ["protocol", "ready", "checks"]) ||
    value.protocol !== 1 ||
    typeof value.ready !== "boolean" ||
    !Array.isArray(value.checks) ||
    value.checks.length !== 5
  )
    return null;
  const seen = new Set<CheckName>();
  const checks: PiCheck[] = [];
  for (const item of value.checks) {
    if (
      !object(item) ||
      !exactKeys(item, ["name", "status", "code"]) ||
      typeof item.name !== "string" ||
      !hasOwn(CHECKS, item.name) ||
      typeof item.code !== "string"
    )
      return null;
    const name = item.name as CheckName;
    const statuses: Readonly<Record<string, string>> = CHECKS[name];
    if (seen.has(name) || !hasOwn(statuses, item.code) || statuses[item.code] !== item.status)
      return null;
    seen.add(name);
    checks.push({ name, status: item.status as CheckStatus, code: item.code });
  }
  if (value.ready !== checks.every((check) => check.status === "ok")) return null;
  return { protocol: 1, ready: value.ready, checks };
}

export async function loadPiDiagnostics(cwd: string | null): Promise<PiDiagnosticOutcome> {
  try {
    const diagnostics = parsePiDiagnostics(
      await invoke<unknown>("continuity_pi_diagnostics", { cwd }),
    );
    return diagnostics ? { ok: true, diagnostics } : { ok: false, code: "diagnostic_invalid" };
  } catch (error) {
    const token = typeof error === "string" ? error : error instanceof Error ? error.message : null;
    const code = FAILURES.find((allowed) => allowed === token) ?? "diagnostic_unavailable";
    return { ok: false, code };
  }
}

export type PiDiagnosticMessage =
  | "ready"
  | "unverified"
  | "unavailable"
  | "configurationMissing"
  | "configurationInvalid"
  | "nodeUnavailable"
  | "nodeUnsupported"
  | "workspaceUnavailable"
  | "dependenciesMissing"
  | "dependenciesInvalid"
  | "modelUnavailable"
  | "authenticationMissing"
  | "authenticationInvalid";

export function piDiagnosticMessages(outcome: PiDiagnosticOutcome): readonly PiDiagnosticMessage[] {
  if (!outcome.ok) {
    const failures: Readonly<Partial<Record<Failure, PiDiagnosticMessage>>> = {
      configuration_missing: "configurationMissing",
      configuration_invalid: "configurationInvalid",
      node_unavailable: "nodeUnavailable",
      workspace_unavailable: "workspaceUnavailable",
    };
    return [failures[outcome.code] ?? "unavailable"];
  }
  if (outcome.diagnostics.ready) return ["ready", "unverified"];
  const reasons: Readonly<Record<string, PiDiagnosticMessage>> = {
    node_unsupported: "nodeUnsupported",
    configuration_invalid: "configurationInvalid",
    dependencies_missing: "dependenciesMissing",
    dependencies_invalid: "dependenciesInvalid",
    model_unavailable: "modelUnavailable",
    authentication_missing: "authenticationMissing",
    authentication_invalid: "authenticationInvalid",
  };
  const messages = outcome.diagnostics.checks
    .filter((check) => check.status !== "ok" && check.status !== "blocked")
    .map((check) => reasons[check.code]);
  return messages.length ? [...new Set(messages)] : ["unavailable"];
}

/** Manual probe only; closing or changing context invalidates every old response. */
export function usePiDiagnostics(cwd: string | null, open: boolean, backend?: string) {
  const key = JSON.stringify([cwd, open, backend]);
  const identity = useRef({ key, generation: 0, active: false });
  if (identity.current.key !== key) {
    identity.current = { key, generation: identity.current.generation + 1, active: false };
  }
  const mounted = useRef(true);
  const [state, setState] = useState<{
    key: string;
    generation: number;
    checking: boolean;
    result: PiDiagnosticOutcome | null;
  }>({ key, generation: identity.current.generation, checking: false, result: null });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      identity.current.generation += 1;
      identity.current.active = false;
    };
  }, []);
  const check = useCallback(async () => {
    if (
      !mounted.current ||
      !open ||
      backend !== "pi" ||
      identity.current.key !== key ||
      identity.current.active
    )
      return;
    const generation = identity.current.generation;
    identity.current.active = true;
    setState({ key, generation, checking: true, result: null });
    const result = await loadPiDiagnostics(cwd);
    if (
      !mounted.current ||
      identity.current.key !== key ||
      identity.current.generation !== generation
    )
      return;
    identity.current.active = false;
    setState({ key, generation, checking: false, result });
  }, [cwd, key, open, backend]);
  return {
    checking:
      state.key === key && state.generation === identity.current.generation && state.checking,
    result:
      state.key === key && state.generation === identity.current.generation ? state.result : null,
    check,
  };
}

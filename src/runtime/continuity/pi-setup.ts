import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

const COMMAND_PRESETS = [
  "workspace-info",
  "validate-json",
  "git-status",
  "git-diff",
  "project-check",
  "project-test",
  "project-build",
] as const;
export type PiCommandPreset = (typeof COMMAND_PRESETS)[number];
export interface PiPermissions {
  readonly read: boolean;
  readonly write: boolean;
  readonly commands: readonly PiCommandPreset[];
}
export interface PiSettings {
  readonly version: 2;
  readonly enabled: boolean;
  readonly provider: "openai";
  readonly model: string;
  readonly authMode: "oauth";
  readonly permissions: PiPermissions;
}
const CODES = [
  "runtime_unavailable",
  "runtime_invalid",
  "node_unavailable",
  "node_invalid",
  "configuration_invalid",
  "workspace_unavailable",
  "authentication_required",
  "model_unavailable",
  "login_busy",
  "login_failed",
  "login_cancelled",
  "login_timeout",
  "browser_unavailable",
  "setup_unavailable",
] as const;
export type PiSetupCode = (typeof CODES)[number];
const PHASES = [
  "idle",
  "starting",
  "waiting",
  "cancelling",
  "connected",
  "cancelled",
  "error",
] as const;
export interface PiLoginStatus {
  readonly phase: (typeof PHASES)[number];
  readonly code: PiSetupCode | null;
}
export interface PiSetupStatus {
  readonly runtimeReady: boolean;
  readonly configured: boolean;
  readonly legacyConfiguration: boolean;
  readonly authenticated: boolean;
  readonly authentication: "present" | "missing" | "invalid";
  readonly model: string;
  readonly models: readonly { readonly id: string; readonly name: string }[];
  readonly permissions: PiPermissions;
  readonly workspaceAvailable: boolean;
  readonly login: PiLoginStatus;
  readonly code: PiSetupCode | null;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]) {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.getOwnPropertyDescriptor(value, key) !== undefined)
  );
}
function code(value: unknown): value is PiSetupCode | null {
  return value === null || CODES.some((item) => item === value);
}
export function parsePiLogin(value: unknown): PiLoginStatus | null {
  if (
    !object(value) ||
    !keys(value, ["phase", "code"]) ||
    !PHASES.some((phase) => value.phase === phase) ||
    !code(value.code)
  )
    return null;
  return value as unknown as PiLoginStatus;
}
export function parsePiSetup(value: unknown): PiSetupStatus | null {
  if (
    !object(value) ||
    !keys(value, [
      "runtimeReady",
      "configured",
      "legacyConfiguration",
      "authenticated",
      "authentication",
      "model",
      "models",
      "permissions",
      "workspaceAvailable",
      "login",
      "code",
    ]) ||
    [
      "runtimeReady",
      "configured",
      "legacyConfiguration",
      "authenticated",
      "workspaceAvailable",
    ].some((key) => typeof value[key] !== "boolean") ||
    !["present", "missing", "invalid"].includes(String(value.authentication)) ||
    typeof value.model !== "string" ||
    value.model.length > 256 ||
    !Array.isArray(value.models) ||
    value.models.length > 1024 ||
    value.models.some(
      (model) =>
        !object(model) ||
        !keys(model, ["id", "name"]) ||
        typeof model.id !== "string" ||
        !model.id ||
        model.id.length > 256 ||
        typeof model.name !== "string" ||
        model.name.length > 256,
    ) ||
    !object(value.permissions) ||
    !keys(value.permissions, ["read", "write", "commands"]) ||
    typeof value.permissions.read !== "boolean" ||
    typeof value.permissions.write !== "boolean" ||
    !Array.isArray(value.permissions.commands) ||
    value.permissions.commands.some(
      (item) => !COMMAND_PRESETS.some((command) => command === item),
    ) ||
    new Set(value.permissions.commands).size !== value.permissions.commands.length ||
    !parsePiLogin(value.login) ||
    !code(value.code)
  )
    return null;
  return value as unknown as PiSetupStatus;
}
function failure(error: unknown): PiSetupCode {
  const value = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return CODES.find((item) => item === value) ?? "setup_unavailable";
}
async function setupStatus(cwd: string | null): Promise<PiSetupStatus> {
  const result = parsePiSetup(await invoke<unknown>("continuity_pi_setup_status", { cwd }));
  if (!result) throw new Error("runtime_invalid");
  return result;
}
async function loginCommand(command: string): Promise<PiLoginStatus> {
  const result = parsePiLogin(await invoke<unknown>(command));
  if (!result) throw new Error("runtime_invalid");
  return result;
}
export const loginActive = (login: PiLoginStatus | undefined) =>
  login !== undefined && ["starting", "waiting", "cancelling"].includes(login.phase);
export const setupReady = (status: PiSetupStatus | null) =>
  Boolean(
    status?.runtimeReady &&
      status.configured &&
      status.authenticated &&
      status.workspaceAvailable &&
      status.models.some((model) => model.id === status.model),
  );

export function usePiSetup(cwd: string | null) {
  const [status, setStatus] = useState<PiSetupStatus | null>(null);
  const [statusCwd, setStatusCwd] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<PiSetupCode | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkingCwd, setCheckingCwd] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const request = useRef(0);
  const statusFlight = useRef<{
    sequence: number;
    invalidated: boolean;
    promise: Promise<void>;
  } | null>(null);
  const inFlight = useRef(false);
  const currentCwd = useRef(cwd);
  currentCwd.current = cwd;
  const refresh = useCallback(
    (invalidate = false): Promise<void> => {
      if (!mounted.current || currentCwd.current !== cwd) return Promise.resolve();
      const pending = statusFlight.current;
      if (pending && pending.sequence === request.current) {
        if (invalidate) pending.invalidated = true;
        return pending.promise;
      }
      const flight = {
        sequence: ++request.current,
        invalidated: false,
        promise: Promise.resolve(),
      };
      statusFlight.current = flight;
      setCheckingCwd(cwd);
      setError(null);
      const isCurrent = () =>
        mounted.current && currentCwd.current === cwd && flight.sequence === request.current;
      flight.promise = (async () => {
        try {
          do {
            flight.invalidated = false;
            try {
              const next = await setupStatus(cwd);
              if (isCurrent() && !flight.invalidated) {
                setStatus(next);
                setStatusCwd(cwd);
                setError(null);
              }
            } catch (cause) {
              if (isCurrent() && !flight.invalidated) setError(failure(cause));
            }
            // 設定・ログイン変更後の確認はまとめて再実行し、変更前の結果を採用しない。
          } while (isCurrent() && flight.invalidated);
        } finally {
          if (isCurrent()) {
            statusFlight.current = null;
            setCheckingCwd(undefined);
            setLoading(false);
          }
        }
      })();
      return flight.promise;
    },
    [cwd],
  );
  useEffect(() => {
    mounted.current = true;
    setLoading(true);
    setStatus(null);
    setError(null);
    void refresh();
    const focus = () => void refresh(true);
    window.addEventListener("focus", focus);
    window.addEventListener("yorishiro:pi-configured", focus);
    return () => {
      mounted.current = false;
      ++request.current;
      statusFlight.current = null;
      window.removeEventListener("focus", focus);
      window.removeEventListener("yorishiro:pi-configured", focus);
    };
  }, [refresh]);
  const currentStatus = statusCwd === cwd ? status : null;
  const phase = currentStatus?.login.phase;
  useEffect(() => {
    if (!phase || !["starting", "waiting", "cancelling"].includes(phase)) return;
    let disposed = false;
    const timer = window.setInterval(() => {
      void loginCommand("continuity_pi_login_status")
        .then((login) => {
          if (disposed || !mounted.current) return;
          setStatus((current) => (current ? { ...current, login } : current));
          if (!loginActive(login)) void refresh(true);
        })
        .catch((cause) => {
          if (!disposed && mounted.current) setError(failure(cause));
        });
    }, 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [phase, refresh]);
  const action = useCallback(
    async (command: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      try {
        const login = await loginCommand(command);
        if (mounted.current) {
          setStatus((current) => (current ? { ...current, login } : current));
          void refresh(true);
        }
      } catch (cause) {
        if (mounted.current) setError(failure(cause));
      } finally {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [refresh],
  );
  const save = useCallback(
    async (settings: PiSettings): Promise<boolean> => {
      if (inFlight.current) return false;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      try {
        const saved = await invoke<unknown>("continuity_pi_setup_save", { cwd, settings });
        window.dispatchEvent(new Event("yorishiro:pi-configured"));
        if (!mounted.current || currentCwd.current !== cwd) return false;
        const next = parsePiSetup(saved);
        if (!next) throw new Error("runtime_invalid");
        setStatus(next);
        setStatusCwd(cwd);
        return true;
      } catch (cause) {
        if (mounted.current && currentCwd.current === cwd) setError(failure(cause));
        return false;
      } finally {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [cwd],
  );
  return {
    status: currentStatus,
    error,
    loading,
    checking: checkingCwd === cwd,
    busy,
    refresh,
    save,
    login: () => action("continuity_pi_login_start"),
    cancel: () => action("continuity_pi_login_cancel"),
  };
}

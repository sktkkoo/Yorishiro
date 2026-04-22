/**
 * MCP tool の TS 側 handler factory。
 *
 * 各 factory は deps を受け取り、純粋な handler function を返す。Tauri
 * invoke / Registry 操作は deps として注入され、test 側で replaceable。
 *
 * Internal design-record: 2026-04-18-phase-1c-rescue-and-mcp.md Section 4.6
 */

import type { UiStateStore } from "../ui-state-store";
import {
  type CharminalConfig,
  withDisabledPackAdded,
  withDisabledPackRemoved,
} from "../user-pack-loader/config";
import type { LoadReport } from "../user-pack-loader/load-report";
import type { UserPackRegistry } from "../user-pack-loader/user-pack-registry";

export interface PackStatusEntry {
  readonly id: string;
  readonly kind: string;
  readonly status: "loaded" | "disabled" | "failed";
}

export interface ListPacksResponse {
  readonly packs: ReadonlyArray<PackStatusEntry>;
}

export interface ListPacksDeps {
  readonly readRegistry: () => Array<{ id: string; kind: string }>;
  readonly readConfig: () => Promise<CharminalConfig>;
  readonly readLoadReport: () => Promise<LoadReport | null>;
}

export function createListPacksHandler(deps: ListPacksDeps) {
  return async (_request: unknown): Promise<ListPacksResponse> => {
    const loaded = deps.readRegistry().map(
      (e): PackStatusEntry => ({
        id: e.id,
        kind: e.kind,
        status: "loaded" as const,
      }),
    );
    const loadedKey = new Set(loaded.map((e) => `${e.kind}:${e.id}`));

    const config = await deps.readConfig();
    const disabled = config.disabledPacks
      .filter((id) => {
        // registry と disabledPacks は loader filter で排他になるはずだが、
        // 念のため「registry に同じ id が無い」ものだけ disabled として表面化。
        return !loaded.some((e) => e.id === id);
      })
      .map(
        (id): PackStatusEntry => ({
          id,
          kind: "",
          status: "disabled" as const,
        }),
      );
    const disabledKey = new Set(disabled.map((e) => `${e.kind}:${e.id}`));

    const report = await deps.readLoadReport();
    const failed: PackStatusEntry[] = [];
    if (report !== null) {
      for (const entry of report.loadResults) {
        if (entry.status !== "failed") continue;
        const key = `${entry.kind}:${entry.id}`;
        if (loadedKey.has(key) || disabledKey.has(key)) continue;
        failed.push({
          id: entry.id,
          kind: entry.kind,
          status: "failed",
        });
      }
    }

    return { packs: [...loaded, ...disabled, ...failed] };
  };
}

export interface DisablePackDeps {
  readonly readConfig: () => Promise<CharminalConfig>;
  readonly writeConfig: (next: CharminalConfig) => Promise<void>;
  readonly registry: UserPackRegistry;
}

export interface SimpleOkResponse {
  readonly ok: boolean;
  readonly reason?: string;
}

export function createDisablePackHandler(deps: DisablePackDeps) {
  return async (request: unknown): Promise<SimpleOkResponse> => {
    const id = (request as { id?: string }).id;
    if (typeof id !== "string" || id === "") {
      return { ok: false, reason: "missing id" };
    }
    const current = await deps.readConfig();
    const next = withDisabledPackAdded(current, id);
    await deps.writeConfig(next);

    // registry から同 id の全 kind を dispose する。
    const entries = deps.registry.listEntries().filter((e) => e.id === id);
    for (const e of entries) {
      deps.registry.dispose(e.id, e.kind);
    }
    return { ok: true };
  };
}

export interface EnablePackDeps {
  readonly readConfig: () => Promise<CharminalConfig>;
  readonly writeConfig: (next: CharminalConfig) => Promise<void>;
  /**
   * 対象 pack を file system から再 load する。Rust の list_user_packs で
   * 該当 id の entry を探し、見つかれば runtime-wire と同じ cache-bust import
   * を通す配線が期待される。見つからなければ ok:false と reason を返す。
   */
  readonly reloadPack: (id: string) => Promise<SimpleOkResponse>;
}

export function createEnablePackHandler(deps: EnablePackDeps) {
  return async (request: unknown): Promise<SimpleOkResponse> => {
    const id = (request as { id?: string }).id;
    if (typeof id !== "string" || id === "") {
      return { ok: false, reason: "missing id" };
    }
    const current = await deps.readConfig();
    const next = withDisabledPackRemoved(current, id);
    await deps.writeConfig(next);
    return await deps.reloadPack(id);
  };
}

function requestRecord(request: unknown): Record<string, unknown> {
  return typeof request === "object" && request !== null
    ? (request as Record<string, unknown>)
    : {};
}

export interface GetUiStateDeps {
  readonly state: UiStateStore;
  readonly getActiveUiId: () => string | null;
}

export type GetUiStateResponse =
  | { readonly packId: string; readonly key: string; readonly value: unknown }
  | { readonly packId: string; readonly state: Record<string, unknown> };

export function createGetUiStateHandler(deps: GetUiStateDeps) {
  return async (request: unknown): Promise<GetUiStateResponse> => {
    const record = requestRecord(request);
    const packId = resolvePackId(record, deps.getActiveUiId);
    const key = record.key;
    if (key === undefined || key === null) {
      return { packId, state: deps.state.entries(packId) };
    }
    if (typeof key !== "string" || key === "") {
      throw new Error("key must be a non-empty string");
    }
    return { packId, key, value: deps.state.get(packId, key) ?? null };
  };
}

export interface SetUiStateDeps {
  readonly state: UiStateStore;
  readonly getActiveUiId: () => string | null;
}

export interface SetUiStateResponse {
  readonly ok: true;
  readonly packId: string;
  readonly key: string;
  readonly value: unknown;
}

export function createSetUiStateHandler(deps: SetUiStateDeps) {
  return async (request: unknown): Promise<SetUiStateResponse> => {
    const record = requestRecord(request);
    const packId = resolvePackId(record, deps.getActiveUiId);
    const key = record.key;
    if (typeof key !== "string" || key === "") {
      throw new Error("key must be a non-empty string");
    }
    if (!("value" in record)) {
      throw new Error("missing value");
    }
    const value = record.value;
    deps.state.set(packId, key, value);
    return { ok: true, packId, key, value };
  };
}

function resolvePackId(
  record: Record<string, unknown>,
  getActiveUiId: () => string | null,
): string {
  const requested = record.packId;
  if (requested !== undefined && requested !== null) {
    if (typeof requested !== "string" || requested === "") {
      throw new Error("packId must be a non-empty string");
    }
    return requested;
  }

  const active = getActiveUiId();
  if (active === null) {
    throw new Error("no active UI pack");
  }
  return active;
}

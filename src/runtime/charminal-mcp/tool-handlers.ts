/**
 * MCP tool の TS 側 handler factory。
 *
 * 各 factory は deps を受け取り、純粋な handler function を返す。Tauri
 * invoke / Registry 操作は deps として注入され、test 側で replaceable。
 *
 * Internal design-record: 2026-04-18-phase-1c-rescue-and-mcp.md Section 4.6
 */

import type { SpaceEffectRequest } from "@charminal/sdk";
import type * as THREE from "three";
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

/* ──────────────────────────────────────────────────────────
 * helper（module-level）
 * ────────────────────────────────────────────────────────── */

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * scene 内の最初の DirectionalLight を 1 個取り出す。
 * camera-lighting-panel 既存実装と同 logic。pack 依存を MCP 層に持ち込まないため
 * 同じ helper を独立に持つ（3 行重複は abstraction より良い、
 * CLAUDE.md「premature abstraction を避ける」）。
 */
function findDirectionalLight(scene: THREE.Scene): THREE.DirectionalLight | null {
  let found: THREE.DirectionalLight | null = null;
  scene.traverse((obj) => {
    if (!found && (obj as THREE.DirectionalLight).isDirectionalLight) {
      found = obj as THREE.DirectionalLight;
    }
  });
  return found;
}

/* ──────────────────────────────────────────────────────────
 * state.get
 * ────────────────────────────────────────────────────────── */

export interface StateGetDeps {
  readonly readConfig: () => Promise<CharminalConfig>;
  readonly getCamera: () => THREE.PerspectiveCamera | null;
  readonly getScene: () => THREE.Scene | null;
  readonly getVrm: () => unknown;
}

export interface StateGetResult {
  readonly config: {
    primaryPersona: string | null;
    activeScene: string | null;
    terminalAgent: "claude" | "codex";
  };
  readonly camera: { position: readonly [number, number, number]; fov: number };
  readonly lighting: { intensity: number; color: string };
  readonly vrmLoaded: boolean;
}

/**
 * config / camera / lighting / vrmLoaded をひとまとめにして返す read-only handler。
 * 各 dependency は null 可で、nil の場合は安全な default を返す（camera 0,0,0 等）。
 */
export function createStateGetHandler(deps: StateGetDeps) {
  return async (_request: unknown): Promise<StateGetResult> => {
    const cfg = await deps.readConfig();
    const cam = deps.getCamera();
    const scene = deps.getScene();
    const light = scene ? findDirectionalLight(scene) : null;
    return {
      config: {
        primaryPersona: cfg.primaryPersona,
        activeScene: cfg.activeScene,
        terminalAgent: cfg.terminalAgent,
      },
      camera: {
        position: cam ? [cam.position.x, cam.position.y, cam.position.z] : [0, 0, 0],
        fov: cam && "fov" in cam ? cam.fov : 0,
      },
      lighting: {
        intensity: light?.intensity ?? 0,
        color: light ? `#${light.color.getHexString()}` : "#ffffff",
      },
      vrmLoaded: deps.getVrm() !== null,
    };
  };
}

/* ──────────────────────────────────────────────────────────
 * body.expression.set
 * ────────────────────────────────────────────────────────── */

export interface BodyExpressionSetDeps {
  readonly getVrm: () => {
    expressionManager?: { setValue: (n: string, v: number) => void };
  } | null;
}

export interface BodyExpressionSetResult {
  readonly preset: string;
  readonly intensity: number;
}

/**
 * VRM expression を preset 名 + intensity (0-1) で設定する handler。
 * intensity を omit すると 1 を default として用い、範囲外は 0-1 に clamp する。
 * VRM が未 load の場合は throw する。
 */
export function createBodyExpressionSetHandler(deps: BodyExpressionSetDeps) {
  return async (request: unknown): Promise<BodyExpressionSetResult> => {
    const r = (request ?? {}) as { preset?: unknown; intensity?: unknown };
    if (typeof r.preset !== "string" || r.preset === "") {
      throw new Error("missing preset");
    }
    const vrm = deps.getVrm();
    if (!vrm?.expressionManager) {
      throw new Error("no VRM loaded");
    }
    const intensity = clamp01(
      typeof r.intensity === "number" && Number.isFinite(r.intensity) ? r.intensity : 1,
    );
    vrm.expressionManager.setValue(r.preset, intensity);
    return { preset: r.preset, intensity };
  };
}

/* ──────────────────────────────────────────────────────────
 * space.effect.play
 * ────────────────────────────────────────────────────────── */

export interface SpaceEffectPlayDeps {
  readonly effectDispatcher: {
    dispatch: (request: SpaceEffectRequest) => unknown;
  };
}

export interface SpaceEffectPlayResult {
  readonly kind: string;
}

/**
 * effect dispatcher 経由で effect pack に reaction を発火する handler。
 * SpaceEffectRequest は flat な discriminated union（kind に応じて intensity / origin /
 * durationMs 等が直に並ぶ）。MCP 経由では payload object でラップして受けるが、dispatch
 * には spread でフラット化して渡す。payload が object でなければ kind のみ送る。
 */
export function createSpaceEffectPlayHandler(deps: SpaceEffectPlayDeps) {
  return async (request: unknown): Promise<SpaceEffectPlayResult> => {
    const r = (request ?? {}) as { kind?: unknown; payload?: unknown };
    if (typeof r.kind !== "string" || r.kind === "") {
      throw new Error("missing kind");
    }
    const payloadObj =
      typeof r.payload === "object" && r.payload !== null && !Array.isArray(r.payload)
        ? (r.payload as Record<string, unknown>)
        : {};
    deps.effectDispatcher.dispatch({ kind: r.kind, ...payloadObj } as SpaceEffectRequest);
    return { kind: r.kind };
  };
}

/* ──────────────────────────────────────────────────────────
 * scene.camera.set
 * ────────────────────────────────────────────────────────── */

export interface SceneCameraSetDeps {
  readonly getCamera: () => THREE.PerspectiveCamera | null;
}

export interface SceneCameraSetResult {
  readonly position: readonly [number, number, number];
  readonly fov: number;
}

function parseVec3(v: unknown): readonly [number, number, number] | undefined {
  if (!Array.isArray(v) || v.length !== 3) return undefined;
  if (!v.every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
  return [v[0] as number, v[1] as number, v[2] as number];
}

/**
 * camera の position / target (lookAt) / fov を opportunistic に更新する handler。
 * 与えられなかった field は変更しない。camera 未準備時は throw する。
 */
export function createSceneCameraSetHandler(deps: SceneCameraSetDeps) {
  return async (request: unknown): Promise<SceneCameraSetResult> => {
    const r = (request ?? {}) as {
      position?: unknown;
      target?: unknown;
      fov?: unknown;
    };
    const cam = deps.getCamera();
    if (!cam) throw new Error("camera not ready");
    const position = parseVec3(r.position);
    const target = parseVec3(r.target);
    if (position) cam.position.set(position[0], position[1], position[2]);
    if (target) cam.lookAt(target[0], target[1], target[2]);
    if (typeof r.fov === "number" && Number.isFinite(r.fov) && "fov" in cam) {
      cam.fov = r.fov;
      cam.updateProjectionMatrix();
    }
    return {
      position: [cam.position.x, cam.position.y, cam.position.z],
      fov: "fov" in cam ? cam.fov : 0,
    };
  };
}

/* ──────────────────────────────────────────────────────────
 * scene.lighting.set
 * ────────────────────────────────────────────────────────── */

export interface SceneLightingSetDeps {
  readonly getScene: () => THREE.Scene | null;
}

export interface SceneLightingSetResult {
  readonly intensity: number;
  readonly color: string;
}

/**
 * scene 内の最初の DirectionalLight に intensity / color を opportunistic に
 * 適用する handler。light が無い場合は throw する。
 */
export function createSceneLightingSetHandler(deps: SceneLightingSetDeps) {
  return async (request: unknown): Promise<SceneLightingSetResult> => {
    const r = (request ?? {}) as { intensity?: unknown; color?: unknown };
    const scene = deps.getScene();
    if (!scene) throw new Error("scene not ready");
    const light = findDirectionalLight(scene);
    if (!light) throw new Error("no DirectionalLight in scene");
    if (typeof r.intensity === "number" && Number.isFinite(r.intensity)) {
      light.intensity = r.intensity;
    }
    if (typeof r.color === "string") {
      light.color.set(r.color);
    }
    return {
      intensity: light.intensity,
      color: `#${light.color.getHexString()}`,
    };
  };
}

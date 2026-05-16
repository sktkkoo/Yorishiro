/**
 * MCP tool の TS 側 handler factory。
 *
 * 各 factory は deps を受け取り、純粋な handler function を返す。Tauri
 * invoke / Registry 操作は deps として注入され、test 側で replaceable。
 *
 * Internal design-record: 2026-04-18-phase-1c-rescue-and-mcp.md Section 4.6
 */

import type {
  Disposable,
  ExpressionHandle,
  MotionHandle,
  MotionSnapshot,
  SpaceEffectRequest,
} from "@charminal/sdk";
import type * as THREE from "three";
import type { Body, ExpressionKind } from "../../core/body";
import type { TweenManager } from "../../core/tween/tween-manager";
import type { TerminalReference, TerminalRegionContext } from "../terminal-runtime/types";
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
  readonly origin: "bundled" | "user";
  readonly status: "loaded" | "disabled" | "failed";
  readonly isActive: boolean;
}

export interface ListPacksResponse {
  readonly packs: ReadonlyArray<PackStatusEntry>;
}

export interface ListPacksDeps {
  readonly readRegistry: () => Array<{ id: string; kind: string }>;
  readonly readBundledPacks: () => Array<{ id: string; kind: string }>;
  readonly readConfig: () => Promise<CharminalConfig>;
  readonly readLoadReport: () => Promise<LoadReport | null>;
  /**
   * single-active 系（scene / ui / persona）の現 active id 群を返す。
   * 各 entry の isActive 判定に使う。multi-active 系は false 固定。
   */
  readonly getActiveIds: () => {
    readonly scene: string | null;
    readonly ui: string | null;
    readonly persona: string | null;
  };
}

export function createListPacksHandler(deps: ListPacksDeps) {
  return async (_request: unknown): Promise<ListPacksResponse> => {
    const activeIds = deps.getActiveIds();
    const isActiveFor = (kind: string, id: string): boolean => {
      if (kind === "scene") return id === activeIds.scene;
      if (kind === "ui") return id === activeIds.ui;
      if (kind === "persona") return id === activeIds.persona;
      return false;
    };

    const bundled = deps.readBundledPacks().map(
      (e): PackStatusEntry => ({
        id: e.id,
        kind: e.kind,
        origin: "bundled",
        status: "loaded" as const,
        isActive: isActiveFor(e.kind, e.id),
      }),
    );

    const loaded = deps.readRegistry().map(
      (e): PackStatusEntry => ({
        id: e.id,
        kind: e.kind,
        origin: "user",
        status: "loaded" as const,
        isActive: isActiveFor(e.kind, e.id),
      }),
    );
    const loadedKey = new Set(loaded.map((e) => `${e.kind}:${e.id}`));

    const config = await deps.readConfig();
    const disabled = config.disabledPacks
      .filter((id) => {
        return !loaded.some((e) => e.id === id);
      })
      .map(
        (id): PackStatusEntry => ({
          id,
          kind: "",
          origin: "user",
          status: "disabled" as const,
          isActive: false,
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
          origin: "user",
          status: "failed",
          isActive: false,
        });
      }
    }

    return { packs: [...bundled, ...loaded, ...disabled, ...failed] };
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

export interface GetPackStateDeps {
  readonly state: UiStateStore;
  readonly getActiveSceneId: () => string | null;
}

export type GetPackStateResponse =
  | { readonly packId: string; readonly key: string; readonly value: unknown }
  | { readonly packId: string; readonly state: Record<string, unknown> };

export function createGetPackStateHandler(deps: GetPackStateDeps) {
  return async (request: unknown): Promise<GetPackStateResponse> => {
    const record = requestRecord(request);
    const packId = deps.getActiveSceneId();
    if (!packId) throw new Error("active な scene pack がありません");
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

export interface SetPackStateDeps {
  readonly state: UiStateStore;
  readonly getActiveSceneId: () => string | null;
}

export interface SetPackStateResponse {
  readonly ok: true;
  readonly packId: string;
  readonly key: string;
  readonly value: unknown;
}

export function createSetPackStateHandler(deps: SetPackStateDeps) {
  return async (request: unknown): Promise<SetPackStateResponse> => {
    const record = requestRecord(request);
    const packId = deps.getActiveSceneId();
    if (!packId) throw new Error("active な scene pack がありません");
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

export interface TerminalContextGetDeps {
  readonly getLatestRegionContext: () => TerminalRegionContext | null;
  readonly getTerminalReferences: () => ReadonlyArray<TerminalReference>;
}

export interface TerminalContextGetResponse {
  readonly context: TerminalRegionContext | null;
  readonly references: ReadonlyArray<TerminalReference>;
}

export function createTerminalContextGetHandler(deps: TerminalContextGetDeps) {
  return async (_request: unknown): Promise<TerminalContextGetResponse> => {
    return {
      context: deps.getLatestRegionContext(),
      references: deps.getTerminalReferences(),
    };
  };
}

/* ──────────────────────────────────────────────────────────
 * controls.get / controls.set / controls.set_many / controls.transition
 * ────────────────────────────────────────────────────────── */

export type ControlScope = "scene" | "common";

export interface ControlStoreLike {
  readonly getVisiblePaths: () => string[];
  readonly getData: () => Record<string, unknown>;
  readonly setValueAtPath: (path: string, value: unknown, fromPanel: boolean) => void;
}

export interface ControlEntry {
  readonly path: string;
  readonly value: unknown;
  readonly type: string;
  readonly label: string;
  readonly disabled: boolean;
}

export type ControlsGetResponse =
  | {
      readonly scope: ControlScope;
      readonly activeSceneId?: string | null;
      readonly controls: ReadonlyArray<ControlEntry>;
    }
  | {
      readonly scope: ControlScope;
      readonly activeSceneId?: string | null;
      readonly control: ControlEntry;
    };

export interface ControlsSetResponse {
  readonly ok: true;
  readonly scope: ControlScope;
  readonly activeSceneId?: string | null;
  readonly path: string;
  readonly value: unknown;
}

export interface ControlsSetManyResponse {
  readonly ok: true;
  readonly scope: ControlScope;
  readonly activeSceneId?: string | null;
  readonly values: Record<string, unknown>;
}

export interface ControlsTransitionResponse extends ControlsSetManyResponse {
  readonly durationMs: number;
  readonly tweening: boolean;
}

export interface ControlsDeps {
  readonly getSceneStore: () => ControlStoreLike | null;
  readonly getCommonStore: () => ControlStoreLike | null;
  readonly getActiveSceneId: () => string | null;
}

export interface ControlsSetDeps extends ControlsDeps {
  readonly tweenManager?: TweenManager;
  readonly onControlSet?: (event: {
    readonly scope: ControlScope;
    readonly path: string;
    readonly value: unknown;
  }) => void;
}

export interface ControlsTransitionDeps extends ControlsSetDeps {
  readonly tweenManager: TweenManager;
}

function parseControlScope(value: unknown): ControlScope {
  if (value === undefined || value === null) return "scene";
  if (value === "scene" || value === "common") return value;
  throw new Error('scope must be "scene" or "common"');
}

function resolveControlStore(
  deps: ControlsDeps,
  scope: ControlScope,
): { store: ControlStoreLike; activeSceneId?: string | null } {
  if (scope === "common") {
    const store = deps.getCommonStore();
    if (store === null) throw new Error("common controls are not available");
    return { store };
  }
  const activeSceneId = deps.getActiveSceneId();
  if (!activeSceneId) throw new Error("active な scene pack がありません");
  const store = deps.getSceneStore();
  if (store === null) throw new Error("scene controls are not available");
  return { store, activeSceneId };
}

function controlInputRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function controlValuesRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("values must be an object");
  }
  return value as Record<string, unknown>;
}

function labelForControl(path: string, input: Record<string, unknown>): string {
  const label = input.label;
  if (typeof label === "string" && label !== "") return label;
  const segments = path.split(".");
  return segments[segments.length - 1] ?? path;
}

function controlEntryFromStore(store: ControlStoreLike, path: string): ControlEntry {
  const data = store.getData();
  const input = controlInputRecord(data[path]);
  if (input === null || !("value" in input)) {
    throw new Error(`control path not found: ${path}`);
  }
  const type = input.type;
  return {
    path,
    value: input.value,
    type: typeof type === "string" ? type : "unknown",
    label: labelForControl(path, input),
    disabled: input.disabled === true,
  };
}

function visibleControlEntries(store: ControlStoreLike): ReadonlyArray<ControlEntry> {
  return store
    .getVisiblePaths()
    .map((path) => {
      try {
        return controlEntryFromStore(store, path);
      } catch {
        return null;
      }
    })
    .filter((entry): entry is ControlEntry => entry !== null);
}

function controlTweenKey(scope: ControlScope, path: string): string {
  return `controls.${scope}.${path}`;
}

function validateControlWrite(store: ControlStoreLike, path: string): ControlEntry {
  if (typeof path !== "string" || path === "") {
    throw new Error("path must be a non-empty string");
  }
  if (!store.getVisiblePaths().includes(path)) {
    throw new Error(`control path not found: ${path}`);
  }
  return controlEntryFromStore(store, path);
}

function applyControlValue(
  deps: ControlsSetDeps,
  scope: ControlScope,
  path: string,
  value: unknown,
  store: ControlStoreLike,
  options?: { cancelTween?: boolean },
): void {
  if (options?.cancelTween !== false) deps.tweenManager?.cancel(controlTweenKey(scope, path));
  store.setValueAtPath(path, value, false);
  deps.onControlSet?.({ scope, path, value });
}

export function createControlsGetHandler(deps: ControlsDeps) {
  return async (request: unknown): Promise<ControlsGetResponse> => {
    const record = requestRecord(request);
    const scope = parseControlScope(record.scope);
    const { store, activeSceneId } = resolveControlStore(deps, scope);
    const path = record.path;
    if (path === undefined || path === null) {
      return { scope, activeSceneId, controls: visibleControlEntries(store) };
    }
    if (typeof path !== "string" || path === "") {
      throw new Error("path must be a non-empty string");
    }
    if (!store.getVisiblePaths().includes(path)) {
      throw new Error(`control path not found: ${path}`);
    }
    return { scope, activeSceneId, control: controlEntryFromStore(store, path) };
  };
}

export function createControlsSetHandler(deps: ControlsSetDeps) {
  return async (request: unknown): Promise<ControlsSetResponse> => {
    const record = requestRecord(request);
    const scope = parseControlScope(record.scope);
    const { store, activeSceneId } = resolveControlStore(deps, scope);
    const path = record.path;
    if (typeof path !== "string" || path === "") {
      throw new Error("path must be a non-empty string");
    }
    if (!("value" in record)) {
      throw new Error("missing value");
    }
    validateControlWrite(store, path);
    const value = record.value;
    applyControlValue(deps, scope, path, value, store);
    return { ok: true, scope, activeSceneId, path, value };
  };
}

export function createControlsSetManyHandler(deps: ControlsSetDeps) {
  return async (request: unknown): Promise<ControlsSetManyResponse> => {
    const record = requestRecord(request);
    const scope = parseControlScope(record.scope);
    const { store, activeSceneId } = resolveControlStore(deps, scope);
    const values = controlValuesRecord(record.values);
    const entries = Object.entries(values);
    if (entries.length === 0) throw new Error("values must not be empty");

    for (const [path] of entries) validateControlWrite(store, path);
    for (const [path, value] of entries) applyControlValue(deps, scope, path, value, store);

    return { ok: true, scope, activeSceneId, values: { ...values } };
  };
}

export function createControlsTransitionHandler(deps: ControlsTransitionDeps) {
  return async (request: unknown): Promise<ControlsTransitionResponse> => {
    const record = requestRecord(request);
    const scope = parseControlScope(record.scope);
    const { store, activeSceneId } = resolveControlStore(deps, scope);
    const values = controlValuesRecord(record.values);
    const entries = Object.entries(values);
    if (entries.length === 0) throw new Error("values must not be empty");

    const durationMs =
      typeof record.durationMs === "number" &&
      Number.isFinite(record.durationMs) &&
      record.durationMs > 0
        ? record.durationMs
        : 0;

    const currentEntries = new Map<string, ControlEntry>();
    for (const [path] of entries) currentEntries.set(path, validateControlWrite(store, path));

    if (durationMs === 0) {
      for (const [path, value] of entries) applyControlValue(deps, scope, path, value, store);
      return { ok: true, scope, activeSceneId, values: { ...values }, durationMs, tweening: false };
    }

    let tweening = false;
    for (const [path, value] of entries) {
      const current = currentEntries.get(path)?.value;
      if (
        typeof current === "number" &&
        Number.isFinite(current) &&
        typeof value === "number" &&
        Number.isFinite(value)
      ) {
        tweening = true;
        deps.tweenManager.start(
          controlTweenKey(scope, path),
          value,
          durationMs,
          (next) => applyControlValue(deps, scope, path, next, store, { cancelTween: false }),
          { from: current },
        );
      } else {
        applyControlValue(deps, scope, path, value, store);
      }
    }

    return { ok: true, scope, activeSceneId, values: { ...values }, durationMs, tweening };
  };
}

/* ──────────────────────────────────────────────────────────
 * helper（module-level）
 * ────────────────────────────────────────────────────────── */

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

const LIGHTING_KEY_PATTERN = /^(ambient|directional)(Intensity|Color)$/;

/** active scene pack の ui-state から lighting 関連 key を抽出する。 */
function extractLighting(
  sceneId: string | null,
  uiState: UiStateStore,
): Record<string, unknown> | null {
  if (!sceneId) return null;
  const all = uiState.entries(sceneId);
  const result: Record<string, unknown> = {};
  let found = false;
  for (const [k, v] of Object.entries(all)) {
    if (LIGHTING_KEY_PATTERN.test(k)) {
      result[k] = v;
      found = true;
    }
  }
  return found ? result : null;
}

/* ──────────────────────────────────────────────────────────
 * state.get
 * ────────────────────────────────────────────────────────── */

/**
 * Body から取り出した slot snapshot を MCP 応答用の plain shape に narrowed する型。
 * Body の SlotSnapshot をそのまま再 export するのではなく、ここで MCP boundary
 * 用の型を独立に定義することで、Body 内部の型変化が tool 応答 contract に
 * 漏れないようにする。
 */
export interface ExpressionSlotEntry {
  readonly source: string;
  readonly kind: string;
  readonly name: string;
  readonly requestedWeight: number;
  readonly effectiveWeight: number;
}

/**
 * Body の subset 型。tool-handlers が必要とする method のみ。
 * test mock を書きやすくするため、Body 全体ではなく shape で受ける。
 */
export interface BodyLike {
  readonly acquireExpressionSlot: Body["acquireExpressionSlot"];
  readonly getExpressionSlots: Body["getExpressionSlots"];
  readonly getMotionSnapshot: Body["getMotionSnapshot"];
  readonly acquireMotionSlot: Body["acquireMotionSlot"];
}

export interface StateGetDeps {
  readonly readConfig: () => Promise<CharminalConfig>;
  readonly getCamera: () => THREE.PerspectiveCamera | null;
  readonly getVrm: () => unknown;
  readonly getBody: () => BodyLike | null;
  readonly tweenManager: TweenManager;
  readonly getSidebarWidth: () => number;
  readonly getTerminalOpacity: () => number;
  readonly getSceneLayerValues: (role: string) => { blur: number; opacity: number };
  readonly getCameraTracking: () => boolean;
  readonly getCameraModulationState: () => {
    readonly enabled: boolean;
    readonly suspended: boolean;
    readonly activeKeys: readonly string[];
  };
  readonly getEffectKinds: () => ReadonlyArray<string>;
  /**
   * 現在 active な single-active pack の id 群（registry 由来、runtime SOT）。
   * config.activeScene / config.primaryPersona は永続値、こちらは runtime 値。
   * runtime-only 切り替え時は両者が divergence する。
   */
  readonly getRuntimeActive: () => {
    readonly scene: string | null;
    readonly ui: string | null;
  };
  /** 存在強度の現在 state を返す。 */
  readonly getPresenceSnapshot: () => {
    readonly level: string;
    readonly levelSince: number;
    readonly previousLevel: string | null;
    readonly previousLevelSince: number | null;
    readonly source: string;
  };
  /** active scene pack の ui-state から lighting 情報を引くための依存。 */
  readonly getActiveSceneId: () => string | null;
  readonly uiState: UiStateStore;
}

export interface StateGetResult {
  readonly config: {
    primaryPersona: string | null;
    activeScene: string | null;
    terminalAgent: "claude" | "codex";
  };
  readonly camera: {
    position: readonly [number, number, number];
    fov: number;
    tracking: boolean;
    modulation: {
      enabled: boolean;
      suspended: boolean;
      activeKeys: readonly string[];
    };
  };
  readonly vrmLoaded: boolean;
  readonly expressions: ReadonlyArray<ExpressionSlotEntry>;
  /**
   * 現在 active な motion の snapshot。`preempted` は単一 active stop model のため
   * 現状常に空配列だが、symmetry 確保のため field として保持される。Body 未生成
   * （VRM 未 load）の場合は `{ active: null, preempted: [] }` を返す。
   */
  readonly motion: MotionSnapshot;
  readonly ui: {
    readonly sidebar: { readonly width: number };
    readonly terminal: { readonly opacity: number };
    readonly sceneLayers: {
      readonly background: { readonly blur: number; readonly opacity: number };
      readonly foreground: { readonly blur: number; readonly opacity: number };
    };
  };
  readonly tweens: ReadonlyArray<{
    readonly key: string;
    readonly progress: number;
    readonly remainingMs: number;
  }>;
  readonly effectKinds: ReadonlyArray<string>;
  /**
   * Registry SOT の active id（永続値の config.activeScene / config.primaryPersona と divergence する）。
   */
  readonly runtime: {
    readonly activeScene: string | null;
    readonly activeUi: string | null;
  };
  /** ISO 8601 形式のローカル時刻。 */
  readonly localTime: string;
  /** active scene pack の ui-state から抽出した lighting 関連値。scene 未 active 時は null。 */
  readonly lighting: Record<string, unknown> | null;
  /** 存在強度の現在 state。 */
  readonly presenceState: {
    readonly level: string;
    readonly levelSince: number;
    readonly previousLevel: string | null;
    readonly previousLevelSince: number | null;
    readonly source: string;
  };
}

/**
 * config / camera / lighting / vrmLoaded / expressions / motion をひとまとめに
 * して返す read-only handler。各 dependency は null 可で、nil の場合は安全な
 * default を返す（camera 0,0,0 等）。expressions は Body.getExpressionSlots() の
 * snapshot を MCP 応答用 shape に詰め替えたもの。motion は Body.getMotionSnapshot()
 * を素通しで返す（preempted は stop model のため常に空配列）。Body 未生成時は
 * expressions = []、motion = { active: null, preempted: [] }。
 */
export function createStateGetHandler(deps: StateGetDeps) {
  return async (_request: unknown): Promise<StateGetResult> => {
    const cfg = await deps.readConfig();
    const cam = deps.getCamera();
    const body = deps.getBody();
    const expressions = body
      ? body.getExpressionSlots().map(
          (s): ExpressionSlotEntry => ({
            source: s.source,
            kind: s.kind,
            name: s.expressionName,
            requestedWeight: s.requestedWeight,
            effectiveWeight: s.effectiveWeight,
          }),
        )
      : [];
    const motion: MotionSnapshot = body?.getMotionSnapshot() ?? {
      active: null,
      preempted: [],
    };
    const runtimeActive = deps.getRuntimeActive();
    const lighting = extractLighting(deps.getActiveSceneId(), deps.uiState);
    return {
      config: {
        primaryPersona: cfg.primaryPersona,
        activeScene: cfg.activeScene,
        terminalAgent: cfg.terminalAgent,
      },
      camera: {
        position: cam ? [cam.position.x, cam.position.y, cam.position.z] : [0, 0, 0],
        fov: cam && "fov" in cam ? cam.fov : 0,
        tracking: deps.getCameraTracking(),
        modulation: deps.getCameraModulationState(),
      },
      vrmLoaded: deps.getVrm() !== null,
      expressions,
      motion,
      ui: {
        sidebar: { width: deps.getSidebarWidth() },
        terminal: { opacity: deps.getTerminalOpacity() },
        sceneLayers: {
          background: deps.getSceneLayerValues("background"),
          foreground: deps.getSceneLayerValues("foreground"),
        },
      },
      lighting,
      tweens: deps.tweenManager.getActive(),
      effectKinds: deps.getEffectKinds(),
      runtime: {
        activeScene: runtimeActive.scene,
        activeUi: runtimeActive.ui,
      },
      localTime: new Date().toISOString(),
      presenceState: deps.getPresenceSnapshot(),
    };
  };
}

/* ──────────────────────────────────────────────────────────
 * body.expression.set
 * ────────────────────────────────────────────────────────── */

export interface BodyExpressionSetDeps {
  readonly getBody: () => BodyLike | null;
}

export interface BodyExpressionSetResult {
  readonly preset: string;
  readonly intensity: number;
  readonly durationMs: number | null;
  readonly transient: boolean;
}

/**
 * MCP module-level の slot 保持 Map。kind ごとに最新の handle を 1 つだけ持ち、
 * 再 acquire 時に前 handle を release する。Body 側の per-(source, kind) dedup
 * があるので二重解放にはならないが、handle.release() を明示呼びすることで
 * blink 抑制 token 等の副作用も漏れなく解放される。
 *
 * Phase β は kind = "mood" のみ公開なので Map に入る entry も実質 1 つだが、
 * 将来 eye / lip / custom を解放した時のために kind 軸で持っておく。
 */
const DEFAULT_MCP_EXPRESSION_DURATION_MS = 1500;

interface ActiveMcpExpressionSlot {
  readonly handle: ExpressionHandle;
  readonly timeoutId: ReturnType<typeof setTimeout> | null;
}

const mcpExpressionSlots = new Map<ExpressionKind, ActiveMcpExpressionSlot>();

function releaseMcpExpressionSlot(kind: ExpressionKind): void {
  const active = mcpExpressionSlots.get(kind);
  if (!active) return;
  if (active.timeoutId !== null) {
    clearTimeout(active.timeoutId);
  }
  active.handle.release();
  mcpExpressionSlots.delete(kind);
}

/**
 * Body の expression mixer に MCP source として slot を acquire / release する
 * handler。intensity を omit すると 1、範囲外は 0-1 に clamp する。
 * durationMs を omit すると短い transient 表情として自動 release する。
 * durationMs: 0 または hold: true は永続 slot として残し、intensity: 0 は
 * 前 slot の release のみ行って新規 acquire しない。Body 未生成（VRM 未 load）
 * の場合は throw する。
 *
 * frame-loop overwrite 問題: 旧実装は `vrm.expressionManager.setValue()` を
 * 直接呼んでいたが、これは Body.applyExpressions() が毎 frame 全 expression を
 * 0 リセット → mixer resolved を再書き込みする実装のため、次 frame に消されて
 * いた。slot 経路に切り替えることで mixer の SOT に登録され、frame をまたいで
 * 維持される。
 */
export function createBodyExpressionSetHandler(deps: BodyExpressionSetDeps) {
  return async (request: unknown): Promise<BodyExpressionSetResult> => {
    const r = (request ?? {}) as {
      preset?: unknown;
      intensity?: unknown;
      durationMs?: unknown;
      hold?: unknown;
    };
    if (typeof r.preset !== "string" || r.preset === "") {
      throw new Error("missing preset");
    }
    const body = deps.getBody();
    if (!body) {
      throw new Error("no VRM loaded");
    }
    const intensity = clamp01(
      typeof r.intensity === "number" && Number.isFinite(r.intensity) ? r.intensity : 1,
    );
    // Phase β は mood のみ MCP 公開。eye / lip / custom は別 tool になる予定。
    const kind: ExpressionKind = "mood";

    // 既存 MCP slot があれば release（per-kind 単 slot）
    releaseMcpExpressionSlot(kind);

    if (intensity === 0) {
      // intensity 0 は release のみ、新規 acquire しない
      return { preset: r.preset, intensity: 0, durationMs: null, transient: false };
    }

    const hold = r.hold === true;
    const rawDurationMs = r.durationMs;
    const durationMs =
      hold || rawDurationMs === 0
        ? null
        : typeof rawDurationMs === "number" && Number.isFinite(rawDurationMs) && rawDurationMs > 0
          ? rawDurationMs
          : DEFAULT_MCP_EXPRESSION_DURATION_MS;
    const transient = durationMs !== null;
    const handle = body.acquireExpressionSlot("mcp", kind, r.preset, intensity);
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    if (transient) {
      timeoutId = setTimeout(() => {
        const active = mcpExpressionSlots.get(kind);
        if (active?.handle !== handle) return;
        active.handle.release();
        mcpExpressionSlots.delete(kind);
      }, durationMs);
    }
    mcpExpressionSlots.set(kind, { handle, timeoutId });
    return { preset: r.preset, intensity, durationMs, transient };
  };
}

/**
 * テスト専用: module-level の MCP slot Map を空にする。
 * 同じ vitest プロセス内で createBodyExpressionSetHandler が複数回 instance 化
 * される場合に、test 同士の slot 漏れを防ぐ。
 */
export function __resetMcpExpressionSlotsForTesting(): void {
  for (const active of mcpExpressionSlots.values()) {
    if (active.timeoutId !== null) {
      clearTimeout(active.timeoutId);
    }
  }
  mcpExpressionSlots.clear();
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

function parseVec3(v: unknown): readonly [number, number, number] | undefined {
  if (!Array.isArray(v) || v.length !== 3) return undefined;
  if (!v.every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
  return [v[0] as number, v[1] as number, v[2] as number];
}

/* ──────────────────────────────────────────────────────────
 * body.animation.play
 * ────────────────────────────────────────────────────────── */

/** MCP source の active motion handle（single active、re-call で前 handle release）。 */
let mcpMotionHandle: MotionHandle | null = null;

export interface BodyAnimationPlayDeps {
  readonly getBody: () => BodyLike | null;
}

export interface BodyAnimationPlayResult {
  readonly animation: string;
  readonly priority: string;
  readonly source: string;
}

/**
 * 住人 AI が body animation を MCP 経由で再生する handler。
 * priority "mcp-conscious" で MotionScheduler に request。
 * re-call で前 MCP motion を release → 新規 acquire。
 *
 * weight default は 1.0 (AnimationPlayer の 0.7 default を override)。
 * MCP-conscious は意識的な motion なので procedural-bones を完全 override する。
 * 部分的に procedural と混ぜたい場合は明示的に weight を渡す（例: weight: 0.5）。
 */
export function createBodyAnimationPlayHandler(deps: BodyAnimationPlayDeps) {
  return async (request: unknown): Promise<BodyAnimationPlayResult> => {
    const r = (request ?? {}) as {
      animation?: unknown;
      fadeInMs?: unknown;
      fadeOutMs?: unknown;
      weight?: unknown;
      loop?: unknown;
      speed?: unknown;
    };
    if (typeof r.animation !== "string" || r.animation === "") {
      throw new Error("missing animation");
    }
    const body = deps.getBody();
    if (!body) {
      throw new Error("no Body loaded");
    }

    // 既存 MCP motion があれば release（single active）
    if (mcpMotionHandle) {
      mcpMotionHandle.release(200);
      mcpMotionHandle = null;
    }

    const handle = body.acquireMotionSlot({
      source: "mcp",
      priority: "mcp-conscious",
      animation: r.animation,
      options: {
        fadeInMs: typeof r.fadeInMs === "number" ? r.fadeInMs : undefined,
        fadeOutMs: typeof r.fadeOutMs === "number" ? r.fadeOutMs : undefined,
        weight: typeof r.weight === "number" ? r.weight : 1.0, // MCP-conscious motion は procedural を override する
        loop: typeof r.loop === "boolean" ? r.loop : undefined,
        speed: typeof r.speed === "number" ? r.speed : undefined,
      },
    });

    // clip load 失敗は短時間で completion が "errored" で resolve される。
    // 1 秒待って検出、正常時は timeout で抜ける。
    const sentinel = Symbol();
    const result = await Promise.race([
      handle.completion,
      new Promise<typeof sentinel>((resolve) => setTimeout(() => resolve(sentinel), 1000)),
    ]);
    if (result !== sentinel && result.reason === "errored") {
      throw new Error(`animation load failed: ${r.animation}`);
    }

    mcpMotionHandle = handle;

    return {
      animation: r.animation,
      priority: "mcp-conscious",
      source: "mcp",
    };
  };
}

/* ──────────────────────────────────────────────────────────
 * body.motion.cancel
 * ────────────────────────────────────────────────────────── */

export interface BodyMotionCancelResult {
  readonly cancelled: boolean;
}

/**
 * MCP source の active body animation を停止する handler。
 * 他 source (persona / state / idle) の motion には影響しない。
 */
export function createBodyMotionCancelHandler() {
  return async (_request: unknown): Promise<BodyMotionCancelResult> => {
    if (!mcpMotionHandle) {
      return { cancelled: false };
    }
    mcpMotionHandle.release(200);
    mcpMotionHandle = null;
    return { cancelled: true };
  };
}

/**
 * テスト用：module-level mcpMotionHandle を reset する。
 * afterEach で呼んで cross-test 汚染を防止。
 */
export function __resetMcpMotionHandleForTesting(): void {
  if (mcpMotionHandle) {
    mcpMotionHandle.release(0);
    mcpMotionHandle = null;
  }
}

/* ──────────────────────────────────────────────────────────
 * ui.terminal.set
 * ────────────────────────────────────────────────────────── */

export interface UiTerminalSetDeps {
  readonly setTerminalOpacity: (value: number) => void;
  readonly getTerminalOpacity: () => number;
  readonly tweenManager: TweenManager;
}

export interface UiTerminalSetResult {
  readonly opacity?: number;
  readonly tweening?: boolean;
}

export function createUiTerminalSetHandler(deps: UiTerminalSetDeps) {
  return async (request: unknown): Promise<UiTerminalSetResult> => {
    const r = requestRecord(request);
    const opacity =
      typeof r.opacity === "number" && Number.isFinite(r.opacity) ? clamp01(r.opacity) : undefined;
    const durationMs =
      typeof r.durationMs === "number" && Number.isFinite(r.durationMs) && r.durationMs > 0
        ? r.durationMs
        : 0;

    if (opacity === undefined) {
      return {};
    }

    if (durationMs > 0) {
      deps.tweenManager.start("ui.terminal.opacity", opacity, durationMs, deps.setTerminalOpacity, {
        from: deps.getTerminalOpacity(),
      });
      return { opacity, tweening: true };
    }

    // 即時: active な tween を cancel + 直接 set
    deps.tweenManager.cancel("ui.terminal.opacity");
    deps.setTerminalOpacity(opacity);
    return { opacity };
  };
}

/* ──────────────────────────────────────────────────────────
 * ui.sidebar.set
 * ────────────────────────────────────────────────────────── */

export interface WindowSize {
  readonly width: number;
  readonly height: number;
}

export interface UiSidebarSetDeps {
  readonly setSidebarWidth: (px: number) => void;
  readonly getSidebarWidth: () => number;
  readonly getDefaultSidebarWidth: () => number;
  readonly getWindowSize: () => WindowSize;
  readonly tweenManager: TweenManager;
}

export interface UiSidebarSetResult {
  readonly width?: number;
  readonly tweening?: boolean;
}

export function createUiSidebarSetHandler(deps: UiSidebarSetDeps) {
  return async (request: unknown): Promise<UiSidebarSetResult> => {
    const r = requestRecord(request);
    const widthPercent =
      typeof r.widthPercent === "number" &&
      Number.isFinite(r.widthPercent) &&
      r.widthPercent >= 0 &&
      r.widthPercent <= 100
        ? r.widthPercent
        : undefined;
    const width =
      widthPercent !== undefined
        ? deps.getWindowSize().width * (widthPercent / 100)
        : typeof r.width === "number" && Number.isFinite(r.width) && r.width >= 0
          ? r.width
          : deps.getDefaultSidebarWidth();
    const durationMs =
      typeof r.durationMs === "number" && Number.isFinite(r.durationMs) && r.durationMs > 0
        ? r.durationMs
        : 0;

    if (durationMs > 0) {
      deps.tweenManager.start("ui.sidebar.width", width, durationMs, deps.setSidebarWidth, {
        from: deps.getSidebarWidth(),
      });
      return { width, tweening: true };
    }

    // 即時: active な tween を cancel + 直接 set
    deps.tweenManager.cancel("ui.sidebar.width");
    deps.setSidebarWidth(width);
    return { width };
  };
}

/* ──────────────────────────────────────────────────────────
 * ui.debugPanel.set
 * ────────────────────────────────────────────────────────── */

export interface UiDebugPanelSetDeps {
  readonly setDebugPanelWidth: (px: number) => void;
  readonly getDebugPanelWidth: () => number;
  readonly getDefaultDebugPanelWidth: () => number;
  readonly tweenManager: TweenManager;
}

export interface UiDebugPanelSetResult {
  readonly width?: number;
  readonly tweening?: boolean;
}

export function createUiDebugPanelSetHandler(deps: UiDebugPanelSetDeps) {
  return async (request: unknown): Promise<UiDebugPanelSetResult> => {
    const r = requestRecord(request);
    const visible = typeof r.visible === "boolean" ? r.visible : undefined;
    const width =
      visible !== undefined
        ? visible
          ? deps.getDefaultDebugPanelWidth()
          : 0
        : typeof r.width === "number" && Number.isFinite(r.width) && r.width >= 0
          ? r.width
          : deps.getDefaultDebugPanelWidth();
    const durationMs =
      typeof r.durationMs === "number" && Number.isFinite(r.durationMs) && r.durationMs > 0
        ? r.durationMs
        : 0;

    if (durationMs > 0) {
      deps.tweenManager.start("ui.debugPanel.width", width, durationMs, deps.setDebugPanelWidth, {
        from: deps.getDebugPanelWidth(),
      });
      return { width, tweening: true };
    }

    deps.tweenManager.cancel("ui.debugPanel.width");
    deps.setDebugPanelWidth(width);
    return { width };
  };
}

/* ──────────────────────────────────────────────────────────
 * scene.activate
 * ────────────────────────────────────────────────────────── */

export interface SceneActivateDeps {
  readonly registry: {
    readonly setActiveScene: (id: string | null) => void;
    readonly getActiveSceneId: () => string | null;
  };
}

export interface SceneActivateResult {
  readonly active: string | null;
}

/**
 * Active scene pack を runtime-only で切り替える handler。
 * registry のみ更新、~/.charminal/config.json は触らない。
 * 不明な id は registry が fall-through で bundled default を選ぶ（throw しない）。
 *
 * 関連: docs/decisions/single-active-config-picks.md（runtime ≠ config の divergence 許容）
 */
export function createSceneActivateHandler(deps: SceneActivateDeps) {
  return async (request: unknown): Promise<SceneActivateResult> => {
    const r = requestRecord(request);
    if (!("id" in r)) {
      throw new Error("id must be non-empty string or null");
    }
    const id = r.id;
    if (id !== null && (typeof id !== "string" || id === "")) {
      throw new Error("id must be non-empty string or null");
    }
    deps.registry.setActiveScene(id);
    return { active: deps.registry.getActiveSceneId() };
  };
}

/* ──────────────────────────────────────────────────────────
 * ui.activate
 * ────────────────────────────────────────────────────────── */

export interface UiActivateDeps {
  readonly registry: {
    readonly setActiveUi: (id: string | null) => void;
    readonly getActiveUiId: () => string | null;
  };
}

export interface UiActivateResult {
  readonly active: string | null;
}

/**
 * Active UI pack を runtime-only で切り替える handler。scene.activate と対称。
 * registry のみ更新、~/.charminal/config.json は触らない。
 */
export function createUiActivateHandler(deps: UiActivateDeps) {
  return async (request: unknown): Promise<UiActivateResult> => {
    const r = requestRecord(request);
    if (!("id" in r)) {
      throw new Error("id must be non-empty string or null");
    }
    const id = r.id;
    if (id !== null && (typeof id !== "string" || id === "")) {
      throw new Error("id must be non-empty string or null");
    }
    deps.registry.setActiveUi(id);
    return { active: deps.registry.getActiveUiId() };
  };
}

/* ──────────────────────────────────────────────────────────
 * scene.screenshot
 * ────────────────────────────────────────────────────────── */

export interface SceneScreenshotDeps {
  readonly getCamera: () => THREE.PerspectiveCamera | null;
  readonly getScene: () => THREE.Scene | null;
  readonly getRenderer: () => THREE.WebGLRenderer | null;
  readonly claimCamera: () => Disposable;
  /** 撮影完了後に呼ばれる任意の hook。screen-flash effect の発火等に使う。 */
  readonly onAfterCapture?: () => void;
}

export interface SceneScreenshotResult {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Three.js canvas のスクリーンショットを撮影する handler。
 * optional camera override（position / target / fov）をアトミックに適用し、
 * 撮影後にカメラを元の状態に復元する。preserveDrawingBuffer: false でも
 * renderer.render() → toDataURL() を同一同期ブロック内で呼ぶため安全。
 *
 * カメラ復元は quaternion ベース。PerspectiveCamera は lookAt target を保持しないため、
 * quaternion が orientation の唯一の SOT。
 */
export function createSceneScreenshotHandler(deps: SceneScreenshotDeps) {
  return async (request: unknown): Promise<SceneScreenshotResult> => {
    const cam = deps.getCamera();
    const scene = deps.getScene();
    const renderer = deps.getRenderer();
    if (!cam || !scene || !renderer) {
      throw new Error("scene not ready");
    }

    const r = (request ?? {}) as {
      position?: unknown;
      target?: unknown;
      fov?: unknown;
    };
    const position = parseVec3(r.position);
    const target = parseVec3(r.target);
    const fovValue = typeof r.fov === "number" && Number.isFinite(r.fov) ? r.fov : undefined;

    const hasOverride = position !== undefined || target !== undefined || fovValue !== undefined;

    const savedPos = cam.position.clone();
    const savedQuat = cam.quaternion.clone();
    const savedFov = cam.fov;

    const claim = deps.claimCamera();

    try {
      if (position) cam.position.set(position[0], position[1], position[2]);
      if (target) cam.lookAt(target[0], target[1], target[2]);
      if (fovValue !== undefined) {
        cam.fov = fovValue;
        cam.updateProjectionMatrix();
      }

      renderer.render(scene, cam);
      const dataUrl = renderer.domElement.toDataURL("image/png");

      // 撮影が完了して dataUrl を握った後に flash を発火する。
      // dataUrl 確定後なので flash 自身が screenshot に写り込むことはない。
      try {
        deps.onAfterCapture?.();
      } catch {
        // hook 失敗は screenshot を壊さない方針: silent に握りつぶす。
      }

      return {
        dataUrl,
        width: renderer.domElement.width,
        height: renderer.domElement.height,
      };
    } finally {
      if (hasOverride) {
        cam.position.copy(savedPos);
        cam.quaternion.copy(savedQuat);
        cam.fov = savedFov;
        cam.updateProjectionMatrix();
      }
      claim.dispose();
    }
  };
}

/* ──────────────────────────────────────────────────────────
 * voice.say
 * ────────────────────────────────────────────────────────── */

export interface VoiceSayDeps {
  readonly speak: (text: string, voice?: string) => void;
  readonly getFrequency: () => "on" | "off";
}

export interface VoiceSayResult {
  readonly spoken: boolean;
}

/**
 * TTS でテキストを発話する handler。VoicePlayer に委譲する。
 * - "on": 常に再生
 * - "off": 常に破棄（global prompt で voice_say を呼ばないよう指示済み）
 */
export function createVoiceSayHandler(deps: VoiceSayDeps) {
  return async (request: unknown): Promise<VoiceSayResult> => {
    if (deps.getFrequency() === "off") return { spoken: false };
    const r = requestRecord(request);
    const text = r.text;
    if (typeof text !== "string" || text === "") {
      return { spoken: false };
    }
    const voice = typeof r.voice === "string" ? r.voice : undefined;
    deps.speak(text, voice);
    return { spoken: true };
  };
}

/* ──────────────────────────────────────────────────────────
 * presence.set-intensity
 * ────────────────────────────────────────────────────────── */

export interface PresenceSetIntensityDeps {
  readonly applyPresenceLevel: (level: "default" | "closed", source: "mcp") => void;
}

export interface PresenceSetIntensityResult {
  readonly level: string;
}

/**
 * 住人の存在強度レベルを MCP 経由で変更する handler。
 * applyPresenceLevel に委譲し、sidebar / VRM / aura の side-effect を発火する。
 */
export function createPresenceSetIntensityHandler(deps: PresenceSetIntensityDeps) {
  return async (request: unknown): Promise<PresenceSetIntensityResult> => {
    const r = requestRecord(request);
    const level = r.level;
    if (level !== "default" && level !== "closed") {
      throw new Error(`invalid presence level: ${String(level)}`);
    }
    deps.applyPresenceLevel(level, "mcp");
    return { level };
  };
}

/* ──────────────────────────────────────────────────────────
 * pomodoro.start / pomodoro.stop / pomodoro.status
 * ────────────────────────────────────────────────────────── */

import type { AmenityPackRegistry } from "../amenity-pack-registry";

export interface PomodoroDeps {
  readonly amenityPackRegistry: AmenityPackRegistry;
}

export function createPomodoroStartHandler(deps: PomodoroDeps) {
  return async (request: unknown): Promise<unknown> => {
    const handle = deps.amenityPackRegistry.getActiveHandle("pomodoro");
    if (!handle) throw new Error("pomodoro amenity is not active");
    return handle.tools.pomodoro_start(request);
  };
}

export function createPomodoroStopHandler(deps: PomodoroDeps) {
  return async (_request: unknown): Promise<unknown> => {
    const handle = deps.amenityPackRegistry.getActiveHandle("pomodoro");
    if (!handle) throw new Error("pomodoro amenity is not active");
    return handle.tools.pomodoro_stop({});
  };
}

export function createPomodoroStatusHandler(deps: PomodoroDeps) {
  return async (_request: unknown): Promise<unknown> => {
    const handle = deps.amenityPackRegistry.getActiveHandle("pomodoro");
    if (!handle) throw new Error("pomodoro amenity is not active");
    return handle.tools.pomodoro_status({});
  };
}

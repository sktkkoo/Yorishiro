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
import { colorLerp } from "../../core/tween/lerp";
import type { TweenManager } from "../../core/tween/tween-manager";
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
}

export type GetPackStateResponse =
  | { readonly packId: string; readonly key: string; readonly value: unknown }
  | { readonly packId: string; readonly state: Record<string, unknown> };

export function createGetPackStateHandler(deps: GetPackStateDeps) {
  return async (request: unknown): Promise<GetPackStateResponse> => {
    const record = requestRecord(request);
    const packId = requirePackId(record);
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
    const packId = requirePackId(record);
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

function requirePackId(record: Record<string, unknown>): string {
  const requested = record.packId;
  if (typeof requested !== "string" || requested === "") {
    throw new Error("packId is required (pack state is per-pack, not app-level)");
  }
  return requested;
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
  readonly getScene: () => THREE.Scene | null;
  readonly getVrm: () => unknown;
  readonly getBody: () => BodyLike | null;
  readonly tweenManager: TweenManager;
  readonly getSidebarWidth: () => number;
  readonly getTerminalOpacity: () => number;
  readonly getSceneLayerValues: (role: string) => { blur: number; opacity: number };
  readonly getCameraTracking: () => boolean;
  readonly getEffectKinds: () => ReadonlyArray<string>;
}

export interface StateGetResult {
  readonly config: {
    primaryPersona: string | null;
    activeScene: string | null;
    terminalAgent: "claude" | "codex";
  };
  readonly camera: { position: readonly [number, number, number]; fov: number; tracking: boolean };
  readonly lighting: { intensity: number; color: string };
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
    const scene = deps.getScene();
    const light = scene ? findDirectionalLight(scene) : null;
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
      },
      lighting: {
        intensity: light?.intensity ?? 0,
        color: light ? `#${light.color.getHexString()}` : "#ffffff",
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
      tweens: deps.tweenManager.getActive(),
      effectKinds: deps.getEffectKinds(),
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
const mcpExpressionSlots = new Map<ExpressionKind, ExpressionHandle>();

/**
 * Body の expression mixer に MCP source として slot を acquire / release する
 * handler。intensity を omit すると 1、範囲外は 0-1 に clamp する。intensity が
 * 0 の場合は前 slot の release のみ行い、新規 acquire はしない。Body 未生成
 * （VRM 未 load）の場合は throw する。
 *
 * frame-loop overwrite 問題: 旧実装は `vrm.expressionManager.setValue()` を
 * 直接呼んでいたが、これは Body.applyExpressions() が毎 frame 全 expression を
 * 0 リセット → mixer resolved を再書き込みする実装のため、次 frame に消されて
 * いた。slot 経路に切り替えることで mixer の SOT に登録され、frame をまたいで
 * 維持される。
 */
export function createBodyExpressionSetHandler(deps: BodyExpressionSetDeps) {
  return async (request: unknown): Promise<BodyExpressionSetResult> => {
    const r = (request ?? {}) as { preset?: unknown; intensity?: unknown };
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
    const previousHandle = mcpExpressionSlots.get(kind);
    if (previousHandle) {
      previousHandle.release();
      mcpExpressionSlots.delete(kind);
    }

    if (intensity === 0) {
      // intensity 0 は release のみ、新規 acquire しない
      return { preset: r.preset, intensity: 0 };
    }

    const handle = body.acquireExpressionSlot("mcp", kind, r.preset, intensity);
    mcpExpressionSlots.set(kind, handle);
    return { preset: r.preset, intensity };
  };
}

/**
 * テスト専用: module-level の MCP slot Map を空にする。
 * 同じ vitest プロセス内で createBodyExpressionSetHandler が複数回 instance 化
 * される場合に、test 同士の slot 漏れを防ぐ。
 */
export function __resetMcpExpressionSlotsForTesting(): void {
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

/* ──────────────────────────────────────────────────────────
 * scene.camera.set
 * ────────────────────────────────────────────────────────── */

export interface SceneCameraSetDeps {
  readonly getCamera: () => THREE.PerspectiveCamera | null;
  readonly tweenManager: TweenManager;
  readonly claimCamera: () => Disposable;
  readonly setCameraTracking: (enabled: boolean) => void;
  readonly getCameraTracking: () => boolean;
}

export interface SceneCameraSetResult {
  readonly position: readonly [number, number, number];
  readonly fov: number;
  readonly tweening?: boolean;
  readonly tracking?: boolean;
}

function parseVec3(v: unknown): readonly [number, number, number] | undefined {
  if (!Array.isArray(v) || v.length !== 3) return undefined;
  if (!v.every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
  return [v[0] as number, v[1] as number, v[2] as number];
}

/**
 * camera の position / target (lookAt) / fov を opportunistic に更新する handler。
 * 与えられなかった field は変更しない。camera 未準備時は throw する。
 *
 * durationMs > 0 の場合は TweenManager で per-frame 補間を行い、補間中は
 * claimCamera() で head-tracking を suspend する。durationMs 省略 / 0 は即時反映
 * （後方互換）。
 */
export function createSceneCameraSetHandler(deps: SceneCameraSetDeps) {
  let cameraClaimDisposable: Disposable | null = null;
  const activeCameraTweenKeys = new Set<string>();

  function ensureCameraClaim(): void {
    if (!cameraClaimDisposable) cameraClaimDisposable = deps.claimCamera();
  }
  function releaseCameraClaimIfDone(): void {
    if (activeCameraTweenKeys.size === 0 && cameraClaimDisposable) {
      cameraClaimDisposable.dispose();
      cameraClaimDisposable = null;
    }
  }
  function trackTween(key: string, handle: { completion: Promise<void> }): void {
    activeCameraTweenKeys.add(key);
    handle.completion.then(() => {
      activeCameraTweenKeys.delete(key);
      releaseCameraClaimIfDone();
    });
  }

  return async (request: unknown): Promise<SceneCameraSetResult> => {
    const r = (request ?? {}) as {
      position?: unknown;
      target?: unknown;
      fov?: unknown;
      durationMs?: unknown;
      tracking?: unknown;
    };
    const cam = deps.getCamera();
    if (!cam) throw new Error("camera not ready");

    const position = parseVec3(r.position);
    const target = parseVec3(r.target);
    const fovValue = typeof r.fov === "number" && Number.isFinite(r.fov) ? r.fov : undefined;
    const durationMs =
      typeof r.durationMs === "number" && Number.isFinite(r.durationMs) && r.durationMs > 0
        ? r.durationMs
        : 0;
    const trackingValue = typeof r.tracking === "boolean" ? r.tracking : undefined;

    if (trackingValue !== undefined) {
      deps.setCameraTracking(trackingValue);
    }

    if (durationMs > 0) {
      ensureCameraClaim();

      if (position) {
        const h = deps.tweenManager.startVec3(
          "camera.position",
          position,
          durationMs,
          (v) => cam.position.set(v[0], v[1], v[2]),
          { from: [cam.position.x, cam.position.y, cam.position.z] },
        );
        trackTween("camera.position", h);
      }
      if (target) {
        // camera.lookAt target は PerspectiveCamera に保持されないため
        // "from" は [0, cam.position.y, 0] で近似（正面向き前提）
        const h = deps.tweenManager.startVec3(
          "camera.target",
          target,
          durationMs,
          (v) => cam.lookAt(v[0], v[1], v[2]),
          { from: [0, cam.position.y, 0] },
        );
        trackTween("camera.target", h);
      }
      if (fovValue !== undefined && "fov" in cam) {
        const h = deps.tweenManager.start(
          "camera.fov",
          fovValue,
          durationMs,
          (v) => {
            cam.fov = v;
            cam.updateProjectionMatrix();
          },
          { from: cam.fov },
        );
        trackTween("camera.fov", h);
      }

      return {
        position: [cam.position.x, cam.position.y, cam.position.z],
        fov: "fov" in cam ? cam.fov : 0,
        tweening: true,
        tracking: deps.getCameraTracking(),
      };
    }

    // Instant mode: cancel active tweens + direct set（既存動作）
    deps.tweenManager.cancel("camera.position");
    deps.tweenManager.cancel("camera.target");
    deps.tweenManager.cancel("camera.fov");
    activeCameraTweenKeys.clear();
    releaseCameraClaimIfDone();

    if (position) cam.position.set(position[0], position[1], position[2]);
    if (target) cam.lookAt(target[0], target[1], target[2]);
    if (fovValue !== undefined && "fov" in cam) {
      cam.fov = fovValue;
      cam.updateProjectionMatrix();
    }

    return {
      position: [cam.position.x, cam.position.y, cam.position.z],
      fov: "fov" in cam ? cam.fov : 0,
      tracking: deps.getCameraTracking(),
    };
  };
}

/* ──────────────────────────────────────────────────────────
 * scene.lighting.set
 * ────────────────────────────────────────────────────────── */

export interface SceneLightingSetDeps {
  readonly getScene: () => THREE.Scene | null;
  readonly tweenManager: TweenManager;
}

export interface SceneLightingSetResult {
  readonly intensity: number;
  readonly color: string;
  readonly tweening?: boolean;
}

/**
 * scene 内の最初の DirectionalLight に intensity / color を opportunistic に
 * 適用する handler。light が無い場合は throw する。
 * durationMs > 0 の場合は TweenManager で per-frame 補間を行う。
 * durationMs 省略 / 0 は即時反映（後方互換）。
 */
export function createSceneLightingSetHandler(deps: SceneLightingSetDeps) {
  return async (request: unknown): Promise<SceneLightingSetResult> => {
    const r = (request ?? {}) as { intensity?: unknown; color?: unknown; durationMs?: unknown };
    const scene = deps.getScene();
    if (!scene) throw new Error("scene not ready");
    const light = findDirectionalLight(scene);
    if (!light) throw new Error("no DirectionalLight in scene");

    const intensityVal =
      typeof r.intensity === "number" && Number.isFinite(r.intensity) ? r.intensity : undefined;
    const colorVal = typeof r.color === "string" ? r.color : undefined;
    const durationMs =
      typeof r.durationMs === "number" && Number.isFinite(r.durationMs) && r.durationMs > 0
        ? r.durationMs
        : 0;

    if (durationMs > 0) {
      if (intensityVal !== undefined) {
        deps.tweenManager.start(
          "lighting.intensity",
          intensityVal,
          durationMs,
          (v) => {
            light.intensity = v;
          },
          { from: light.intensity },
        );
      }
      if (colorVal !== undefined) {
        deps.tweenManager.startWithLerp(
          "lighting.color",
          `#${light.color.getHexString()}`,
          colorVal,
          durationMs,
          colorLerp,
          (v) => light.color.set(v),
        );
      }
      return {
        intensity: light.intensity,
        color: `#${light.color.getHexString()}`,
        tweening: true,
      };
    }

    // Instant mode: cancel active tweens + direct set（既存動作）
    deps.tweenManager.cancel("lighting.intensity");
    deps.tweenManager.cancel("lighting.color");
    if (intensityVal !== undefined) {
      light.intensity = intensityVal;
    }
    if (colorVal !== undefined) {
      light.color.set(colorVal);
    }
    return {
      intensity: light.intensity,
      color: `#${light.color.getHexString()}`,
    };
  };
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
 * ui.scene-layer.set
 * ────────────────────────────────────────────────────────── */

export interface UiSceneLayerSetDeps {
  readonly updateSceneLayer: (
    target: { role: string },
    patch: { blur?: number | null; opacity?: number | null },
  ) => void;
  readonly getSceneLayerValues: (role: string) => { blur: number; opacity: number };
  readonly tweenManager: TweenManager;
}

export interface UiSceneLayerSetResult {
  readonly role: string;
  readonly blur?: number | null;
  readonly opacity?: number | null;
  readonly tweening?: boolean;
}

export function createUiSceneLayerSetHandler(deps: UiSceneLayerSetDeps) {
  return async (request: unknown): Promise<UiSceneLayerSetResult> => {
    const r = requestRecord(request);
    const role = r.role;
    if (role !== "background" && role !== "foreground") {
      throw new Error('role must be "background" or "foreground"');
    }
    const blur = typeof r.blur === "number" && Number.isFinite(r.blur) ? r.blur : undefined;
    const opacity =
      typeof r.opacity === "number" && Number.isFinite(r.opacity) ? clamp01(r.opacity) : undefined;
    const durationMs =
      typeof r.durationMs === "number" && Number.isFinite(r.durationMs) && r.durationMs > 0
        ? r.durationMs
        : 0;

    if (durationMs > 0) {
      const current = deps.getSceneLayerValues(role);
      if (blur !== undefined) {
        deps.tweenManager.start(
          `scene.layer.blur.${role}`,
          blur,
          durationMs,
          (v) => deps.updateSceneLayer({ role }, { blur: v }),
          { from: current.blur },
        );
      }
      if (opacity !== undefined) {
        deps.tweenManager.start(
          `scene.layer.opacity.${role}`,
          opacity,
          durationMs,
          (v) => deps.updateSceneLayer({ role }, { opacity: v }),
          { from: current.opacity },
        );
      }
      return { role, blur, opacity, tweening: true };
    }

    // 即時: active な tween を cancel + 直接 set
    deps.tweenManager.cancel(`scene.layer.blur.${role}`);
    deps.tweenManager.cancel(`scene.layer.opacity.${role}`);
    const patch: { blur?: number | null; opacity?: number | null } = {};
    if (blur !== undefined) patch.blur = blur;
    if (opacity !== undefined) patch.opacity = opacity;
    // null reset のサポート: raw request に明示的 null があるかチェック
    if (r.blur === null) patch.blur = null;
    if (r.opacity === null) patch.opacity = null;
    deps.updateSceneLayer({ role }, patch);
    return { role, blur, opacity };
  };
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

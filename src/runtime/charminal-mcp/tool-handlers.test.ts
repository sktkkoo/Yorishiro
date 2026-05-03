/**
 * MCP tool handler の pure logic テスト。
 *
 * Tauri invoke / file I/O は caller が inject する形にして、ここでは
 * merge 規則と state 更新の correctness のみ確認する。
 */

import type { SpaceEffectRequest, UiContext, UiLayout, UiPackManifest } from "@charminal/sdk";
import type * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TweenManager } from "../../core/tween/tween-manager";
import type { SceneSpec } from "../../sdk/scene";
import type { ScenePackManifest } from "../../sdk/scene-pack";
import { ScenePackRegistryImpl } from "../scene-pack-registry/scene-pack-registry";
import { createUiPackRegistry } from "../ui-pack-registry";
import { createUiStateStore } from "../ui-state-store";
import { EMPTY_CONFIG } from "../user-pack-loader/config";
import type { LoadReport } from "../user-pack-loader/load-report";
import { UserPackRegistry } from "../user-pack-loader/user-pack-registry";
import {
  __resetMcpExpressionSlotsForTesting,
  __resetMcpMotionHandleForTesting,
  type BodyLike,
  createBodyAnimationPlayHandler,
  createBodyExpressionSetHandler,
  createBodyMotionCancelHandler,
  createDisablePackHandler,
  createEnablePackHandler,
  createGetPackStateHandler,
  createListPacksHandler,
  createSceneActivateHandler,
  createSceneCameraSetHandler,
  createSceneLightingSetHandler,
  createSceneScreenshotHandler,
  createSetPackStateHandler,
  createSpaceEffectPlayHandler,
  createStateGetHandler,
  createUiActivateHandler,
  createUiSceneLayerSetHandler,
  createUiSidebarSetHandler,
  createUiTerminalSetHandler,
} from "./tool-handlers";

/**
 * Three.js / VRM 型のフルセットを mock で再現するのは過剰なので、
 * test 内で必要な subset を `as unknown as <T>` で narrow する。
 */
type SceneLike = THREE.Scene;
type CameraLike = THREE.PerspectiveCamera;
type SceneObjectLike = THREE.Object3D;

describe("list_packs handler", () => {
  it("merges registry / disabledPacks / load-report.failed under their invariants", async () => {
    const registry = new UserPackRegistry();
    registry.register("a", "effect", { dispose: () => {} });
    registry.register("b", "persona", { dispose: () => {} });

    const report: LoadReport = {
      timestamp: "2026-04-18T00:00:00.000Z",
      safeMode: false,
      loadResults: [
        { id: "a", kind: "effect", status: "loaded" },
        { id: "b", kind: "persona", status: "loaded" },
        {
          id: "broken",
          kind: "effect",
          status: "failed",
          error: { phase: "validate", message: "shape" },
        },
      ],
    };

    const handler = createListPacksHandler({
      readRegistry: () => registry.listEntries(),
      readBundledPacks: () => [],
      readConfig: async () => ({
        ...EMPTY_CONFIG,
        disabledPacks: ["c"],
      }),
      readLoadReport: async () => report,
      getActiveIds: () => ({ scene: null, ui: null, persona: null }),
    });

    const result = await handler({});
    expect(result).toEqual({
      packs: expect.arrayContaining([
        { id: "a", kind: "effect", origin: "user", status: "loaded", isActive: false },
        { id: "b", kind: "persona", origin: "user", status: "loaded", isActive: false },
        { id: "c", kind: "", origin: "user", status: "disabled", isActive: false },
        { id: "broken", kind: "effect", origin: "user", status: "failed", isActive: false },
      ]),
    });
    expect((result as { packs: unknown[] }).packs).toHaveLength(4);
  });

  it("prefers loaded over failed when registry and load-report disagree (registry wins)", async () => {
    const registry = new UserPackRegistry();
    registry.register("a", "effect", { dispose: () => {} });

    const report: LoadReport = {
      timestamp: "2026-04-18T00:00:00.000Z",
      safeMode: false,
      loadResults: [
        {
          id: "a",
          kind: "effect",
          status: "failed",
          error: { phase: "import", message: "stale" },
        },
      ],
    };

    const handler = createListPacksHandler({
      readRegistry: () => registry.listEntries(),
      readBundledPacks: () => [],
      readConfig: async () => EMPTY_CONFIG,
      readLoadReport: async () => report,
      getActiveIds: () => ({ scene: null, ui: null, persona: null }),
    });

    const result = await handler({});
    expect(result.packs).toHaveLength(1);
    expect(result.packs[0].status).toBe("loaded");
  });

  it("marks isActive based on getActiveIds for single-active kinds", async () => {
    const registry = new UserPackRegistry();
    registry.register("user-scene", "scene", { dispose: () => {} });
    registry.register("user-ui", "ui", { dispose: () => {} });

    const handler = createListPacksHandler({
      readRegistry: () => registry.listEntries(),
      readBundledPacks: () => [
        { id: "bundled-scene", kind: "scene" },
        { id: "bundled-ui", kind: "ui" },
        { id: "bundled-persona", kind: "persona" },
        { id: "bundled-effect", kind: "effect" },
      ],
      readConfig: async () => EMPTY_CONFIG,
      readLoadReport: async () => null,
      getActiveIds: () => ({
        scene: "user-scene",
        ui: "bundled-ui",
        persona: null,
      }),
    });

    const result = await handler({});
    const byId = new Map(result.packs.map((p) => [`${p.kind}:${p.id}`, p]));
    expect(byId.get("scene:user-scene")?.isActive).toBe(true);
    expect(byId.get("scene:bundled-scene")?.isActive).toBe(false);
    expect(byId.get("ui:user-ui")?.isActive).toBe(false);
    expect(byId.get("ui:bundled-ui")?.isActive).toBe(true);
    expect(byId.get("persona:bundled-persona")?.isActive).toBe(false);
    expect(byId.get("effect:bundled-effect")?.isActive).toBe(false);
  });
});

describe("disable_pack handler", () => {
  it("adds id to config.disabledPacks and disposes the matching registry entries", async () => {
    const registry = new UserPackRegistry();
    const disposed: string[] = [];
    registry.register("target", "effect", {
      dispose: () => {
        disposed.push("target:effect");
      },
    });
    registry.register("target", "persona", {
      dispose: () => {
        disposed.push("target:persona");
      },
    });

    let writtenConfig: string | null = null;

    const handler = createDisablePackHandler({
      readConfig: async () => EMPTY_CONFIG,
      writeConfig: async (next) => {
        writtenConfig = JSON.stringify(next);
      },
      registry,
    });

    const result = await handler({ id: "target" });
    expect(result).toEqual({ ok: true });
    expect(disposed.sort()).toEqual(["target:effect", "target:persona"]);
    expect(registry.has("target", "effect")).toBe(false);
    expect(registry.has("target", "persona")).toBe(false);
    expect(writtenConfig).toContain('"target"');
  });

  it("is idempotent when id is already disabled", async () => {
    const handler = createDisablePackHandler({
      readConfig: async () => ({
        ...EMPTY_CONFIG,
        disabledPacks: ["already"],
      }),
      writeConfig: async () => {},
      registry: new UserPackRegistry(),
    });
    const result = await handler({ id: "already" });
    expect(result).toEqual({ ok: true });
  });
});

describe("enable_pack handler", () => {
  it("removes id from config.disabledPacks and triggers reload", async () => {
    let reloadCalled: string | null = null;
    let writtenConfig: { disabledPacks: string[] } | null = null;

    const handler = createEnablePackHandler({
      readConfig: async () => ({
        ...EMPTY_CONFIG,
        disabledPacks: ["a", "target", "b"],
      }),
      writeConfig: async (next) => {
        writtenConfig = { disabledPacks: Array.from(next.disabledPacks) };
      },
      reloadPack: async (id) => {
        reloadCalled = id;
        return { ok: true };
      },
    });

    const result = await handler({ id: "target" });
    expect(result).toEqual({ ok: true });
    expect(reloadCalled).toBe("target");
    expect(writtenConfig).toEqual({ disabledPacks: ["a", "b"] });
  });

  it("returns ok:false when reloadPack reports file not found", async () => {
    const handler = createEnablePackHandler({
      readConfig: async () => EMPTY_CONFIG,
      writeConfig: async () => {},
      reloadPack: async () => ({ ok: false, reason: "pack file not found" }),
    });
    const result = await handler({ id: "ghost" });
    expect(result).toEqual({ ok: false, reason: "pack file not found" });
  });
});

describe("ui_state handlers", () => {
  it("sets and gets a single UI state key", async () => {
    const state = createUiStateStore();
    const deps = { state };
    const set = createSetPackStateHandler(deps);
    const get = createGetPackStateHandler(deps);

    await expect(
      set({ packId: "camera-lighting-panel", key: "camera.x", value: 1.5 }),
    ).resolves.toEqual({
      ok: true,
      packId: "camera-lighting-panel",
      key: "camera.x",
      value: 1.5,
    });
    await expect(get({ packId: "camera-lighting-panel", key: "camera.x" })).resolves.toEqual({
      packId: "camera-lighting-panel",
      key: "camera.x",
      value: 1.5,
    });
  });

  it("returns the full UI state snapshot when key is omitted", async () => {
    const state = createUiStateStore();
    state.set("camera-lighting-panel", "camera.x", 1);
    state.set("camera-lighting-panel", "lighting.color", "#ff8800");
    state.set("secondary-ui", "camera.x", 99);

    const get = createGetPackStateHandler({ state });
    await expect(get({ packId: "camera-lighting-panel" })).resolves.toEqual({
      packId: "camera-lighting-panel",
      state: {
        "camera.x": 1,
        "lighting.color": "#ff8800",
      },
    });
  });

  it("rejects empty keys", async () => {
    const state = createUiStateStore();
    const deps = { state };
    const set = createSetPackStateHandler(deps);
    const get = createGetPackStateHandler(deps);

    await expect(set({ packId: "test", key: "", value: 1 })).rejects.toThrow(
      "key must be a non-empty string",
    );
    await expect(get({ packId: "test", key: "" })).rejects.toThrow(
      "key must be a non-empty string",
    );
  });

  it("requires value for set_ui_state but allows null", async () => {
    const state = createUiStateStore();
    const deps = { state };
    const set = createSetPackStateHandler(deps);
    const get = createGetPackStateHandler(deps);

    await expect(set({ packId: "test", key: "camera.x" })).rejects.toThrow("missing value");
    await expect(set({ packId: "test", key: "camera.x", value: null })).resolves.toEqual({
      ok: true,
      packId: "test",
      key: "camera.x",
      value: null,
    });
    await expect(get({ packId: "test", key: "camera.x" })).resolves.toEqual({
      packId: "test",
      key: "camera.x",
      value: null,
    });
  });

  it("pack state は pack ごとに分離されている", async () => {
    const state = createUiStateStore();
    const deps = { state };
    const set = createSetPackStateHandler(deps);
    const get = createGetPackStateHandler(deps);

    await set({ packId: "pack-a", key: "visible", value: true });
    await set({ packId: "pack-b", key: "visible", value: false });

    await expect(get({ packId: "pack-a", key: "visible" })).resolves.toEqual({
      packId: "pack-a",
      key: "visible",
      value: true,
    });
    await expect(get({ packId: "pack-b", key: "visible" })).resolves.toEqual({
      packId: "pack-b",
      key: "visible",
      value: false,
    });
  });

  it("packId 省略時はエラー", async () => {
    const state = createUiStateStore();
    const deps = { state };
    const set = createSetPackStateHandler(deps);
    const get = createGetPackStateHandler(deps);

    await expect(set({ key: "camera.x", value: 1 })).rejects.toThrow("packId is required");
    await expect(get({ key: "camera.x" })).rejects.toThrow("packId is required");
  });
});

describe("createStateGetHandler", () => {
  it("aggregates config + camera + lighting + vrmLoaded + expressions", async () => {
    const handler = createStateGetHandler({
      readConfig: vi.fn().mockResolvedValue({
        primaryPersona: "p1",
        activeScene: "s1",
        terminalAgent: "claude" as const,
      }),
      getCamera: () => ({ position: { x: 1, y: 2, z: 3 }, fov: 45 }) as unknown as CameraLike,
      getScene: () =>
        ({
          traverse: (cb: (obj: SceneObjectLike) => void) =>
            cb({
              isDirectionalLight: true,
              intensity: 0.8,
              color: { getHexString: () => "ffeecc" },
            } as unknown as SceneObjectLike),
        }) as unknown as SceneLike,
      getVrm: () => ({}),
      getBody: () =>
        ({
          acquireExpressionSlot: vi.fn(),
          getExpressionSlots: () => [
            {
              source: "mcp",
              kind: "mood",
              expressionName: "happy",
              requestedWeight: 0.7,
              effectiveWeight: 0.7,
            },
          ],
          getMotionSnapshot: () => ({ active: null, preempted: [] }),
        }) as unknown as BodyLike,
      tweenManager: new TweenManager(),
      getSidebarWidth: () => 280,
      getTerminalOpacity: () => 1,
      getSceneLayerValues: () => ({ blur: 0, opacity: 1 }),
      getCameraTracking: () => true,
      getEffectKinds: () => [],
      getRuntimeActive: () => ({ scene: null, ui: null }),
    });
    const result = await handler({});
    expect(result).toMatchObject({
      config: { primaryPersona: "p1", activeScene: "s1", terminalAgent: "claude" },
      camera: { position: [1, 2, 3], fov: 45, tracking: true },
      lighting: { intensity: 0.8, color: "#ffeecc" },
      vrmLoaded: true,
      expressions: [
        {
          source: "mcp",
          kind: "mood",
          name: "happy",
          requestedWeight: 0.7,
          effectiveWeight: 0.7,
        },
      ],
      motion: { active: null, preempted: [] },
      runtime: {
        activeScene: null,
        activeUi: null,
      },
    });
  });

  it("handles null camera / no light / no vrm / no body gracefully", async () => {
    const handler = createStateGetHandler({
      readConfig: vi.fn().mockResolvedValue({
        primaryPersona: null,
        activeScene: null,
        terminalAgent: "claude" as const,
      }),
      getCamera: () => null,
      getScene: () => null,
      getVrm: () => null,
      getBody: () => null,
      tweenManager: new TweenManager(),
      getSidebarWidth: () => 280,
      getTerminalOpacity: () => 1,
      getSceneLayerValues: () => ({ blur: 0, opacity: 1 }),
      getCameraTracking: () => true,
      getEffectKinds: () => [],
      getRuntimeActive: () => ({ scene: null, ui: null }),
    });
    const result = await handler({});
    expect(result.camera.position).toEqual([0, 0, 0]);
    expect(result.lighting.intensity).toBe(0);
    expect(result.vrmLoaded).toBe(false);
    expect(result.expressions).toEqual([]);
    // body 未生成時は motion も安全な default に落ちる
    expect(result.motion).toEqual({ active: null, preempted: [] });
  });

  it("returns motion snapshot from body.getMotionSnapshot", async () => {
    const motionSnapshot = {
      active: {
        source: "persona" as const,
        priority: "persona-handler" as const,
        animation: "anim:wave",
        startedAt: 12345,
      },
      preempted: [],
    };
    const handler = createStateGetHandler({
      readConfig: vi.fn().mockResolvedValue({
        primaryPersona: null,
        activeScene: null,
        terminalAgent: "claude" as const,
      }),
      getCamera: () => null,
      getScene: () => null,
      getVrm: () => null,
      getBody: () =>
        ({
          acquireExpressionSlot: vi.fn(),
          getExpressionSlots: () => [],
          getMotionSnapshot: () => motionSnapshot,
        }) as unknown as BodyLike,
      tweenManager: new TweenManager(),
      getSidebarWidth: () => 280,
      getTerminalOpacity: () => 1,
      getSceneLayerValues: () => ({ blur: 0, opacity: 1 }),
      getCameraTracking: () => true,
      getEffectKinds: () => [],
      getRuntimeActive: () => ({ scene: null, ui: null }),
    });
    const result = await handler({});
    expect(result.motion).toEqual(motionSnapshot);
  });

  it("returns lighting defaults when scene has no DirectionalLight", async () => {
    const handler = createStateGetHandler({
      readConfig: vi.fn().mockResolvedValue({
        primaryPersona: null,
        activeScene: null,
        terminalAgent: "claude" as const,
      }),
      getCamera: () => null,
      getScene: () =>
        ({
          traverse: (_cb: (obj: SceneObjectLike) => void) => {},
        }) as unknown as SceneLike,
      getVrm: () => null,
      getBody: () => null,
      tweenManager: new TweenManager(),
      getSidebarWidth: () => 280,
      getTerminalOpacity: () => 1,
      getSceneLayerValues: () => ({ blur: 0, opacity: 1 }),
      getCameraTracking: () => true,
      getEffectKinds: () => [],
      getRuntimeActive: () => ({ scene: null, ui: null }),
    });
    const result = await handler({});
    expect(result.lighting.intensity).toBe(0);
    expect(result.lighting.color).toBe("#ffffff");
    expect(result.expressions).toEqual([]);
  });

  it("ui section を返す", async () => {
    const handler = createStateGetHandler({
      readConfig: async () => ({
        primaryPersona: null,
        activeScene: null,
        terminalAgent: "claude" as const,
        disabledPacks: [],
        ambientAudioMuted: false,
        mcpPort: null,
        activeUi: null,
        activeAmbientUi: [],
      }),
      getCamera: () => null,
      getScene: () => null,
      getVrm: () => null,
      getBody: () => null,
      tweenManager: new TweenManager(),
      getSidebarWidth: () => 350,
      getTerminalOpacity: () => 0.7,
      getSceneLayerValues: (role) =>
        role === "background" ? { blur: 5, opacity: 0.8 } : { blur: 0, opacity: 1 },
      getCameraTracking: () => true,
      getEffectKinds: () => [],
      getRuntimeActive: () => ({ scene: null, ui: null }),
    });
    const result = await handler({});
    expect(result.ui.sidebar.width).toBe(350);
    expect(result.ui.terminal.opacity).toBe(0.7);
    expect(result.ui.sceneLayers.background).toEqual({ blur: 5, opacity: 0.8 });
  });

  it("active tween を tweens に返す", async () => {
    const tm = new TweenManager();
    tm.start("test-key", 100, 1000, () => {}, { from: 0 });
    const handler = createStateGetHandler({
      readConfig: async () => ({
        primaryPersona: null,
        activeScene: null,
        terminalAgent: "claude" as const,
        disabledPacks: [],
        ambientAudioMuted: false,
        mcpPort: null,
        activeUi: null,
        activeAmbientUi: [],
      }),
      getCamera: () => null,
      getScene: () => null,
      getVrm: () => null,
      getBody: () => null,
      tweenManager: tm,
      getSidebarWidth: () => 280,
      getTerminalOpacity: () => 1,
      getSceneLayerValues: () => ({ blur: 0, opacity: 1 }),
      getCameraTracking: () => true,
      getEffectKinds: () => [],
      getRuntimeActive: () => ({ scene: null, ui: null }),
    });
    const result = await handler({});
    expect(result.tweens.length).toBe(1);
    expect(result.tweens[0].key).toBe("test-key");
  });

  it("includes runtime.activeScene / activeUi from registries (independent of config)", async () => {
    const handler = createStateGetHandler({
      readConfig: vi.fn().mockResolvedValue({
        primaryPersona: null,
        activeScene: "config-scene", // 永続値
        terminalAgent: "claude" as const,
      }),
      getCamera: () => null,
      getScene: () => null,
      getVrm: () => null,
      getBody: () => null,
      tweenManager: new TweenManager(),
      getSidebarWidth: () => 280,
      getTerminalOpacity: () => 1,
      getSceneLayerValues: () => ({ blur: 0, opacity: 1 }),
      getCameraTracking: () => false,
      getEffectKinds: () => [],
      getRuntimeActive: () => ({
        scene: "runtime-scene", // divergence: registry が config と違う
        ui: "runtime-ui",
      }),
    });

    const result = await handler({});
    expect(result.config.activeScene).toBe("config-scene");
    expect(result.runtime).toEqual({
      activeScene: "runtime-scene",
      activeUi: "runtime-ui",
    });
  });
});

describe("createBodyExpressionSetHandler", () => {
  /**
   * Body.acquireExpressionSlot の戻り値（ExpressionHandle）を mock する helper。
   * release / setIntensity は spy として観察可能。effectiveWeight は固定値で OK。
   */
  function makeMockHandle() {
    return {
      target: { kind: "mood" as const, preset: "happy" as const },
      requestedIntensity: 0,
      effectiveWeight: 0,
      release: vi.fn(),
      setIntensity: vi.fn(),
    };
  }

  function makeMockBody(): {
    body: BodyLike;
    acquireExpressionSlot: ReturnType<typeof vi.fn>;
    getExpressionSlots: ReturnType<typeof vi.fn>;
    handles: ReturnType<typeof makeMockHandle>[];
  } {
    const handles: ReturnType<typeof makeMockHandle>[] = [];
    const acquireExpressionSlot = vi.fn(() => {
      const h = makeMockHandle();
      handles.push(h);
      return h;
    });
    const getExpressionSlots = vi.fn(() => []);
    const body = {
      acquireExpressionSlot,
      getExpressionSlots,
    } as unknown as BodyLike;
    return { body, acquireExpressionSlot, getExpressionSlots, handles };
  }

  beforeEach(() => {
    __resetMcpExpressionSlotsForTesting();
  });

  it("acquires expression slot via Body.acquireExpressionSlot with mcp source / mood kind", async () => {
    const { body, acquireExpressionSlot } = makeMockBody();
    const handler = createBodyExpressionSetHandler({ getBody: () => body });
    const result = await handler({ preset: "happy", intensity: 0.7 });
    expect(acquireExpressionSlot).toHaveBeenCalledWith("mcp", "mood", "happy", 0.7);
    expect(result).toEqual({ preset: "happy", intensity: 0.7 });
  });

  it("defaults intensity to 1 when omitted", async () => {
    const { body, acquireExpressionSlot } = makeMockBody();
    const handler = createBodyExpressionSetHandler({ getBody: () => body });
    await handler({ preset: "happy" });
    expect(acquireExpressionSlot).toHaveBeenCalledWith("mcp", "mood", "happy", 1);
  });

  it("clamps intensity to 0-1 range", async () => {
    const { body, acquireExpressionSlot } = makeMockBody();
    const handler = createBodyExpressionSetHandler({ getBody: () => body });
    await handler({ preset: "happy", intensity: 2 });
    expect(acquireExpressionSlot).toHaveBeenLastCalledWith("mcp", "mood", "happy", 1);
    // -0.5 → 0、ただし 0 は acquire しない（release のみ）
    await handler({ preset: "happy", intensity: -0.5 });
    // 直前は 1 で acquire 済み、次は intensity 0 なので追加 acquire 無し
    expect(acquireExpressionSlot).toHaveBeenCalledTimes(1);
  });

  it("re-acquires: previous handle.release is called and new slot acquired", async () => {
    const { body, acquireExpressionSlot, handles } = makeMockBody();
    const handler = createBodyExpressionSetHandler({ getBody: () => body });

    await handler({ preset: "happy", intensity: 0.5 });
    expect(handles).toHaveLength(1);
    expect(handles[0].release).not.toHaveBeenCalled();

    await handler({ preset: "sad", intensity: 0.6 });
    // 前 handle が release され、新規 acquire が走る
    expect(handles[0].release).toHaveBeenCalledTimes(1);
    expect(acquireExpressionSlot).toHaveBeenCalledTimes(2);
    expect(acquireExpressionSlot).toHaveBeenLastCalledWith("mcp", "mood", "sad", 0.6);
  });

  it("intensity 0: releases previous slot without new acquire", async () => {
    const { body, acquireExpressionSlot, handles } = makeMockBody();
    const handler = createBodyExpressionSetHandler({ getBody: () => body });

    await handler({ preset: "happy", intensity: 0.5 });
    expect(handles).toHaveLength(1);

    const result = await handler({ preset: "happy", intensity: 0 });
    expect(handles[0].release).toHaveBeenCalledTimes(1);
    // intensity 0 は acquire しない
    expect(acquireExpressionSlot).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ preset: "happy", intensity: 0 });
  });

  it("throws when Body not available", async () => {
    const handler = createBodyExpressionSetHandler({ getBody: () => null });
    await expect(handler({ preset: "happy" })).rejects.toThrow(/no VRM loaded/);
  });

  it("throws on missing preset", async () => {
    const { body } = makeMockBody();
    const handler = createBodyExpressionSetHandler({ getBody: () => body });
    await expect(handler({})).rejects.toThrow(/preset/);
  });
});

describe("createSpaceEffectPlayHandler", () => {
  it("dispatches with kind and flattened payload", async () => {
    const dispatch = vi.fn();
    const handler = createSpaceEffectPlayHandler({
      effectDispatcher: { dispatch } as unknown as {
        dispatch: (r: SpaceEffectRequest) => unknown;
      },
    });
    const result = await handler({
      kind: "fireworks",
      payload: { origin: { x: 0.5, y: 0.5 }, count: 30, durationMs: 1500 },
    });
    // payload field を spread してフラット化することを assert
    expect(dispatch).toHaveBeenCalledWith({
      kind: "fireworks",
      origin: { x: 0.5, y: 0.5 },
      count: 30,
      durationMs: 1500,
    });
    expect(result).toEqual({ kind: "fireworks" });
  });

  it("dispatches with kind only when no payload", async () => {
    const dispatch = vi.fn();
    const handler = createSpaceEffectPlayHandler({
      effectDispatcher: { dispatch } as unknown as {
        dispatch: (r: SpaceEffectRequest) => unknown;
      },
    });
    await handler({ kind: "shake" });
    // payload なしの時は kind のみ
    expect(dispatch).toHaveBeenCalledWith({ kind: "shake" });
  });

  it("throws on missing kind", async () => {
    const handler = createSpaceEffectPlayHandler({
      effectDispatcher: { dispatch: vi.fn() } as unknown as {
        dispatch: (r: SpaceEffectRequest) => unknown;
      },
    });
    await expect(handler({})).rejects.toThrow(/kind/);
  });
});

describe("createSceneCameraSetHandler", () => {
  let trackingEnabled = true;
  const mockTrackingDeps = {
    setCameraTracking: (enabled: boolean) => {
      trackingEnabled = enabled;
    },
    getCameraTracking: () => trackingEnabled,
  };

  function makeMockCamera() {
    return {
      position: {
        x: 0,
        y: 0,
        z: 0,
        set: vi.fn(function (
          this: { x: number; y: number; z: number },
          x: number,
          y: number,
          z: number,
        ) {
          this.x = x;
          this.y = y;
          this.z = z;
        }),
      },
      lookAt: vi.fn(),
      fov: 50,
      updateProjectionMatrix: vi.fn(),
    };
  }

  it("sets position / target / fov when given", async () => {
    const camera = makeMockCamera();
    const handler = createSceneCameraSetHandler({
      getCamera: () => camera as unknown as CameraLike,
      tweenManager: new TweenManager(),
      claimCamera: () => ({ dispose: () => {} }),
      ...mockTrackingDeps,
    });
    const result = await handler({ position: [1, 2, 3], target: [4, 5, 6], fov: 30 });
    expect(camera.position.set).toHaveBeenCalledWith(1, 2, 3);
    expect(camera.lookAt).toHaveBeenCalledWith(4, 5, 6);
    expect(camera.fov).toBe(30);
    expect(camera.updateProjectionMatrix).toHaveBeenCalled();
    expect(result.fov).toBe(30);
  });

  it("throws when camera not ready", async () => {
    const handler = createSceneCameraSetHandler({
      getCamera: () => null,
      tweenManager: new TweenManager(),
      claimCamera: () => ({ dispose: () => {} }),
      ...mockTrackingDeps,
    });
    await expect(handler({ position: [1, 2, 3] })).rejects.toThrow(/camera not ready/);
  });

  it("durationMs > 0 で tween 登録 + tweening: true", async () => {
    const tm = new TweenManager();
    const mockCamera = makeMockCamera();
    const handler = createSceneCameraSetHandler({
      getCamera: () => mockCamera as unknown as CameraLike,
      tweenManager: tm,
      claimCamera: () => ({ dispose: () => {} }),
      ...mockTrackingDeps,
    });
    const result = await handler({
      position: [1.5, 1.3, 0],
      durationMs: 1000,
    });
    expect(result.tweening).toBe(true);
    expect(tm.isActive("camera.position")).toBe(true);
  });

  it("durationMs 省略で即時反映（後方互換）", async () => {
    const tm = new TweenManager();
    const mockCamera = makeMockCamera();
    const handler = createSceneCameraSetHandler({
      getCamera: () => mockCamera as unknown as CameraLike,
      tweenManager: tm,
      claimCamera: () => ({ dispose: () => {} }),
      ...mockTrackingDeps,
    });
    const result = await handler({ position: [1, 2, 3] });
    expect(result.tweening).toBeUndefined();
    expect(mockCamera.position.x).toBe(1);
  });

  it("instant set が active tween を cancel", async () => {
    const tm = new TweenManager();
    const mockCamera = makeMockCamera();
    const handler = createSceneCameraSetHandler({
      getCamera: () => mockCamera as unknown as CameraLike,
      tweenManager: tm,
      claimCamera: () => ({ dispose: () => {} }),
      ...mockTrackingDeps,
    });
    await handler({ position: [1, 1, 1], durationMs: 1000 });
    expect(tm.isActive("camera.position")).toBe(true);
    await handler({ position: [2, 2, 2] });
    expect(tm.isActive("camera.position")).toBe(false);
  });
});

describe("createSceneLightingSetHandler", () => {
  const mockLight = {
    isDirectionalLight: true,
    intensity: 0.5,
    color: { set: vi.fn(), getHexString: () => "ff8800" },
  };
  const mockScene = {
    traverse: (cb: (obj: SceneObjectLike) => void) => cb(mockLight as unknown as SceneObjectLike),
  };

  beforeEach(() => {
    mockLight.intensity = 0.5;
    mockLight.color.set = vi.fn();
    mockLight.color.getHexString = () => "ff8800";
  });

  it("sets intensity and color on DirectionalLight", async () => {
    const handler = createSceneLightingSetHandler({
      getScene: () => mockScene as unknown as SceneLike,
      tweenManager: new TweenManager(),
    });
    const result = await handler({ intensity: 0.9, color: "#ff8800" });
    expect(mockLight.intensity).toBe(0.9);
    expect(mockLight.color.set).toHaveBeenCalledWith("#ff8800");
    expect(result).toEqual({ intensity: 0.9, color: "#ff8800" });
  });

  it("throws when no DirectionalLight in scene", async () => {
    const handler = createSceneLightingSetHandler({
      getScene: () =>
        ({
          traverse: (_cb: (obj: SceneObjectLike) => void) => {},
        }) as unknown as SceneLike,
      tweenManager: new TweenManager(),
    });
    await expect(handler({ intensity: 0.5 })).rejects.toThrow(/no DirectionalLight/);
  });

  it("durationMs > 0 で tween 登録", async () => {
    const tm = new TweenManager();
    const handler = createSceneLightingSetHandler({
      getScene: () => mockScene as unknown as SceneLike,
      tweenManager: tm,
    });
    const result = await handler({ intensity: 0.5, durationMs: 800 });
    expect(result.tweening).toBe(true);
    expect(tm.isActive("lighting.intensity")).toBe(true);
  });

  it("durationMs 省略で即時反映（後方互換）", async () => {
    const tm = new TweenManager();
    const handler = createSceneLightingSetHandler({
      getScene: () => mockScene as unknown as SceneLike,
      tweenManager: tm,
    });
    const result = await handler({ intensity: 0.3 });
    expect(result.tweening).toBeUndefined();
    expect(mockLight.intensity).toBe(0.3);
  });
});

describe("createBodyAnimationPlayHandler", () => {
  afterEach(() => {
    __resetMcpMotionHandleForTesting();
  });

  function makeMockMotionHandle(overrides?: Partial<{ animation: string; startedAt: number }>) {
    return {
      source: "mcp" as const,
      priority: "mcp-conscious" as const,
      animation: overrides?.animation ?? "anim:wave",
      startedAt: overrides?.startedAt ?? 1000,
      release: vi.fn(),
      cancel: vi.fn(),
      isActive: () => true,
      isPreempted: () => false,
      completion: new Promise<{ reason: "completed" | "cancelled" | "preempted" }>(() => {}),
    };
  }

  it("acquires motion slot at mcp-conscious priority", async () => {
    const mockHandle = makeMockMotionHandle();
    const acquireMotionSlot = vi.fn().mockReturnValue(mockHandle);
    const body = {
      acquireMotionSlot,
      getMotionSnapshot: vi.fn(),
      getExpressionSlots: vi.fn().mockReturnValue([]),
      acquireExpressionSlot: vi.fn(),
    };
    const handler = createBodyAnimationPlayHandler({
      getBody: () => body as unknown as BodyLike,
    });
    const result = await handler({ animation: "anim:wave" });
    expect(acquireMotionSlot).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "mcp",
        priority: "mcp-conscious",
        animation: "anim:wave",
      }),
    );
    expect(result).toEqual({
      animation: "anim:wave",
      priority: "mcp-conscious",
      source: "mcp",
    });
  });

  it("releases previous MCP motion on re-call", async () => {
    const handle1 = makeMockMotionHandle({ animation: "anim:wave" });
    const handle2 = makeMockMotionHandle({ animation: "anim:nod", startedAt: 2000 });
    const acquireMotionSlot = vi.fn().mockReturnValueOnce(handle1).mockReturnValueOnce(handle2);
    const body = {
      acquireMotionSlot,
      getMotionSnapshot: vi.fn(),
      getExpressionSlots: vi.fn().mockReturnValue([]),
      acquireExpressionSlot: vi.fn(),
    };
    const handler = createBodyAnimationPlayHandler({
      getBody: () => body as unknown as BodyLike,
    });
    await handler({ animation: "anim:wave" });
    await handler({ animation: "anim:nod" });
    expect(handle1.release).toHaveBeenCalledWith(200);
  });

  it("throws when no Body loaded", async () => {
    const handler = createBodyAnimationPlayHandler({ getBody: () => null });
    await expect(handler({ animation: "anim:wave" })).rejects.toThrow(/no Body loaded/);
  });

  it("throws on missing animation", async () => {
    const body = {
      acquireMotionSlot: vi.fn(),
      getMotionSnapshot: vi.fn(),
      getExpressionSlots: vi.fn().mockReturnValue([]),
      acquireExpressionSlot: vi.fn(),
    };
    const handler = createBodyAnimationPlayHandler({
      getBody: () => body as unknown as BodyLike,
    });
    await expect(handler({})).rejects.toThrow(/missing animation/);
  });
});

describe("createBodyMotionCancelHandler", () => {
  afterEach(() => {
    __resetMcpMotionHandleForTesting();
  });

  it("returns cancelled: false when no MCP motion active", async () => {
    const handler = createBodyMotionCancelHandler();
    const result = await handler({});
    expect(result).toEqual({ cancelled: false });
  });

  it("releases and returns cancelled: true when MCP motion active", async () => {
    const release = vi.fn();
    const mockHandle = {
      source: "mcp" as const,
      priority: "mcp-conscious" as const,
      animation: "anim:wave",
      startedAt: 1000,
      release,
      cancel: vi.fn(),
      isActive: () => true,
      isPreempted: () => false,
      completion: new Promise<{ reason: "completed" | "cancelled" | "preempted" }>(() => {}),
    };
    const acquireMotionSlot = vi.fn().mockReturnValue(mockHandle);
    const body = {
      acquireMotionSlot,
      getMotionSnapshot: vi.fn(),
      getExpressionSlots: vi.fn().mockReturnValue([]),
      acquireExpressionSlot: vi.fn(),
    };
    // play で module-level handle を設定
    const playHandler = createBodyAnimationPlayHandler({
      getBody: () => body as unknown as BodyLike,
    });
    await playHandler({ animation: "anim:wave" });

    // cancel
    const cancelHandler = createBodyMotionCancelHandler();
    const result = await cancelHandler({});
    expect(result).toEqual({ cancelled: true });
    expect(release).toHaveBeenCalledWith(200);
  });
});

describe("createUiSceneLayerSetHandler", () => {
  it("durationMs > 0 で tween 登録 + tweening: true", async () => {
    const tm = new TweenManager();
    const patches: Array<{ role: string; patch: Record<string, unknown> }> = [];
    const handler = createUiSceneLayerSetHandler({
      updateSceneLayer: (target, patch) => patches.push({ role: target.role, patch }),
      getSceneLayerValues: () => ({ blur: 0, opacity: 1 }),
      tweenManager: tm,
    });
    const result = await handler({ role: "background", blur: 8, durationMs: 600 });
    expect(result.tweening).toBe(true);
    expect(tm.isActive("scene.layer.blur.background")).toBe(true);
  });

  it("durationMs 省略で即時反映", async () => {
    const tm = new TweenManager();
    const patches: Array<{ role: string; patch: Record<string, unknown> }> = [];
    const handler = createUiSceneLayerSetHandler({
      updateSceneLayer: (target, patch) => patches.push({ role: target.role, patch }),
      getSceneLayerValues: () => ({ blur: 0, opacity: 1 }),
      tweenManager: tm,
    });
    const result = await handler({ role: "background", blur: 5 });
    expect(result.tweening).toBeUndefined();
    expect(patches.length).toBe(1);
    expect(patches[0].patch).toEqual({ blur: 5 });
  });

  it("不正な role で throw", async () => {
    const tm = new TweenManager();
    const handler = createUiSceneLayerSetHandler({
      updateSceneLayer: () => {},
      getSceneLayerValues: () => ({ blur: 0, opacity: 1 }),
      tweenManager: tm,
    });
    await expect(handler({ role: "invalid" })).rejects.toThrow("role");
  });

  it("blur のみ指定で opacity は変更しない", async () => {
    const tm = new TweenManager();
    const patches: Array<Record<string, unknown>> = [];
    const handler = createUiSceneLayerSetHandler({
      updateSceneLayer: (_target, patch) => patches.push(patch),
      getSceneLayerValues: () => ({ blur: 0, opacity: 1 }),
      tweenManager: tm,
    });
    await handler({ role: "foreground", blur: 3 });
    expect(patches[0]).toEqual({ blur: 3 });
  });
});

describe("createUiTerminalSetHandler", () => {
  it("durationMs > 0 で tween 登録 + tweening: true", async () => {
    const tm = new TweenManager();
    const handler = createUiTerminalSetHandler({
      setTerminalOpacity: () => {},
      getTerminalOpacity: () => 1,
      tweenManager: tm,
    });
    const result = await handler({ opacity: 0.5, durationMs: 400 });
    expect(result.tweening).toBe(true);
    expect(tm.isActive("ui.terminal.opacity")).toBe(true);
  });

  it("durationMs 省略で即時反映", async () => {
    const tm = new TweenManager();
    let setTo = -1;
    const handler = createUiTerminalSetHandler({
      setTerminalOpacity: (v) => {
        setTo = v;
      },
      getTerminalOpacity: () => 1,
      tweenManager: tm,
    });
    const result = await handler({ opacity: 0.5 });
    expect(result.tweening).toBeUndefined();
    expect(setTo).toBe(0.5);
  });
});

describe("createUiSidebarSetHandler", () => {
  const windowSize = { width: 1200, height: 800 };

  it("durationMs > 0 で tween 登録 + tweening: true", async () => {
    const tm = new TweenManager();
    const handler = createUiSidebarSetHandler({
      setSidebarWidth: () => {},
      getSidebarWidth: () => 280,
      getDefaultSidebarWidth: () => 280,
      getWindowSize: () => windowSize,
      tweenManager: tm,
    });
    const result = await handler({ width: 350, durationMs: 800 });
    expect(result.tweening).toBe(true);
    expect(tm.isActive("ui.sidebar.width")).toBe(true);
  });

  it("durationMs 省略で即時反映", async () => {
    const tm = new TweenManager();
    let setTo = -1;
    const handler = createUiSidebarSetHandler({
      setSidebarWidth: (v) => {
        setTo = v;
      },
      getSidebarWidth: () => 280,
      getDefaultSidebarWidth: () => 280,
      getWindowSize: () => windowSize,
      tweenManager: tm,
    });
    const result = await handler({ width: 350 });
    expect(result.tweening).toBeUndefined();
    expect(setTo).toBe(350);
  });

  it("width: 0 でサイドバー非表示", async () => {
    const tm = new TweenManager();
    let setTo = -1;
    const handler = createUiSidebarSetHandler({
      setSidebarWidth: (v) => {
        setTo = v;
      },
      getSidebarWidth: () => 280,
      getDefaultSidebarWidth: () => 280,
      getWindowSize: () => windowSize,
      tweenManager: tm,
    });
    const result = await handler({ width: 0 });
    expect(setTo).toBe(0);
    expect(result.width).toBe(0);
  });

  it("widthPercent でウィンドウ幅に対する割合指定", async () => {
    const tm = new TweenManager();
    let setTo = -1;
    const handler = createUiSidebarSetHandler({
      setSidebarWidth: (v) => {
        setTo = v;
      },
      getSidebarWidth: () => 280,
      getDefaultSidebarWidth: () => 280,
      getWindowSize: () => windowSize,
      tweenManager: tm,
    });
    const result = await handler({ widthPercent: 50 });
    expect(setTo).toBe(600);
    expect(result.width).toBe(600);
  });

  it("widthPercent が width より優先", async () => {
    const tm = new TweenManager();
    let setTo = -1;
    const handler = createUiSidebarSetHandler({
      setSidebarWidth: (v) => {
        setTo = v;
      },
      getSidebarWidth: () => 280,
      getDefaultSidebarWidth: () => 280,
      getWindowSize: () => windowSize,
      tweenManager: tm,
    });
    const result = await handler({ width: 400, widthPercent: 80 });
    expect(setTo).toBe(960);
    expect(result.width).toBe(960);
  });

  it("width 省略でデフォルト幅にフォールバック", async () => {
    const tm = new TweenManager();
    let setTo = -1;
    const handler = createUiSidebarSetHandler({
      setSidebarWidth: (v) => {
        setTo = v;
      },
      getSidebarWidth: () => 400,
      getDefaultSidebarWidth: () => 280,
      getWindowSize: () => windowSize,
      tweenManager: tm,
    });
    const result = await handler({});
    expect(setTo).toBe(280);
    expect(result.width).toBe(280);
  });
});

describe("createSceneActivateHandler", () => {
  const sceneSpec = (id: string) => ({ id, layers: [] }) as unknown as SceneSpec;
  const manifest = (id: string) => ({ id, name: id }) as unknown as ScenePackManifest;
  const makeRegistry = () => {
    const r = new ScenePackRegistryImpl();
    r.register({ id: "s1", manifest: manifest("s1"), scene: sceneSpec("s1"), origin: "bundled" });
    r.register({ id: "s2", manifest: manifest("s2"), scene: sceneSpec("s2"), origin: "bundled" });
    return r;
  };

  it("switches active scene by id", async () => {
    const registry = makeRegistry();
    const handler = createSceneActivateHandler({ registry });
    const result = await handler({ id: "s2" });
    expect(result).toEqual({ active: "s2" });
    expect(registry.getActiveSceneId()).toBe("s2");
  });

  it("clears active when id is null", async () => {
    const registry = makeRegistry();
    const handler = createSceneActivateHandler({ registry });
    // initial active is "s1" (alphabetical fallback)
    expect(registry.getActiveSceneId()).toBe("s1");
    const result = await handler({ id: null });
    // setActive(null) → fallback re-applies → alphabetical "s1"
    expect(result.active).toBe("s1");
  });

  it("rejects empty string id", async () => {
    const registry = makeRegistry();
    const handler = createSceneActivateHandler({ registry });
    await expect(handler({ id: "" })).rejects.toThrow("id must be non-empty string or null");
  });

  it("rejects non-string non-null id", async () => {
    const registry = makeRegistry();
    const handler = createSceneActivateHandler({ registry });
    await expect(handler({ id: 42 })).rejects.toThrow("id must be non-empty string or null");
  });

  it("rejects when id field is omitted", async () => {
    const registry = makeRegistry();
    const handler = createSceneActivateHandler({ registry });
    await expect(handler({})).rejects.toThrow("id must be non-empty string or null");
  });

  it("setting unknown id falls through to bundled fallback (no throw)", async () => {
    const registry = makeRegistry();
    const handler = createSceneActivateHandler({ registry });
    // SingleActiveRegistry.setActive で unknown id は fall-through、bundled alphabetical 先頭が active
    const result = await handler({ id: "ghost" });
    expect(result.active).toBe("s1");
  });
});

describe("createUiActivateHandler", () => {
  const makeRegistry = () => {
    const r = createUiPackRegistry();
    r.register({
      id: "u1",
      origin: "bundled",
      manifest: { id: "u1", name: "U1" } as unknown as UiPackManifest,
      pack: {
        layout: { mode: "auto" } as unknown as UiLayout,
        mount: (_: UiContext) => ({ dispose: () => {} }),
      },
    });
    r.register({
      id: "u2",
      origin: "bundled",
      manifest: { id: "u2", name: "U2" } as unknown as UiPackManifest,
      pack: {
        layout: { mode: "auto" } as unknown as UiLayout,
        mount: (_: UiContext) => ({ dispose: () => {} }),
      },
    });
    return r;
  };

  it("switches active ui by id", async () => {
    const registry = makeRegistry();
    const handler = createUiActivateHandler({ registry });
    const result = await handler({ id: "u2" });
    expect(result).toEqual({ active: "u2" });
    expect(registry.getActiveUiId()).toBe("u2");
  });

  it("clears with null (UI pack registry uses nullMeansNoActive=true)", async () => {
    const registry = makeRegistry();
    const handler = createUiActivateHandler({ registry });
    await handler({ id: "u1" });
    const result = await handler({ id: null });
    // UiPackRegistry は nullMeansNoActive=true なので null で active も null
    expect(result).toEqual({ active: null });
    expect(registry.getActiveUiId()).toBeNull();
  });

  it("rejects empty string", async () => {
    const handler = createUiActivateHandler({ registry: makeRegistry() });
    await expect(handler({ id: "" })).rejects.toThrow("id must be non-empty string or null");
  });

  it("rejects when id field is omitted", async () => {
    const handler = createUiActivateHandler({ registry: makeRegistry() });
    await expect(handler({})).rejects.toThrow("id must be non-empty string or null");
  });
});

/* ──────────────────────────────────────────────────────────
 * scene.screenshot
 * ────────────────────────────────────────────────────────── */

describe("scene.screenshot handler", () => {
  function makeMockCanvas() {
    return {
      toDataURL: vi.fn(() => "data:image/png;base64,AAAA"),
      width: 800,
      height: 600,
    };
  }

  function makeMockRenderer(canvas: ReturnType<typeof makeMockCanvas>) {
    return {
      render: vi.fn(),
      domElement: canvas,
    } as unknown as THREE.WebGLRenderer;
  }

  function makeMockCamera() {
    return {
      position: { x: 0, y: 1.35, z: 1.1, set: vi.fn(), clone: vi.fn(), copy: vi.fn() },
      quaternion: { clone: vi.fn(), copy: vi.fn() },
      fov: 35,
      updateProjectionMatrix: vi.fn(),
      lookAt: vi.fn(),
    } as unknown as THREE.PerspectiveCamera;
  }

  function makeDeps(
    overrides: Partial<{
      camera: THREE.PerspectiveCamera | null;
      scene: THREE.Scene | null;
      renderer: THREE.WebGLRenderer | null;
    }> = {},
  ) {
    const canvas = makeMockCanvas();
    const renderer =
      overrides.renderer !== undefined ? overrides.renderer : makeMockRenderer(canvas);
    const camera = overrides.camera !== undefined ? overrides.camera : makeMockCamera();
    const scene = overrides.scene !== undefined ? overrides.scene : ({} as THREE.Scene);
    const claimDispose = vi.fn();
    return {
      canvas,
      renderer,
      camera,
      scene,
      claimDispose,
      deps: {
        getCamera: () => camera,
        getScene: () => scene,
        getRenderer: () => renderer,
        claimCamera: () => ({ dispose: claimDispose }),
      },
    };
  }

  it("default camera でキャプチャできる", async () => {
    const { deps, canvas } = makeDeps();
    const handler = createSceneScreenshotHandler(deps);
    const result = await handler({});
    expect(result.dataUrl).toBe("data:image/png;base64,AAAA");
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
    expect(canvas.toDataURL).toHaveBeenCalledWith("image/png");
  });

  it("camera override を適用して復元する", async () => {
    const { deps, camera } = makeDeps();
    const cam = camera as unknown as {
      position: {
        set: ReturnType<typeof vi.fn>;
        clone: ReturnType<typeof vi.fn>;
        copy: ReturnType<typeof vi.fn>;
      };
      quaternion: { clone: ReturnType<typeof vi.fn>; copy: ReturnType<typeof vi.fn> };
      fov: number;
      updateProjectionMatrix: ReturnType<typeof vi.fn>;
      lookAt: ReturnType<typeof vi.fn>;
    };
    const savedPos = { x: 0, y: 1.35, z: 1.1 };
    const savedQuat = { x: 0, y: 0, z: 0, w: 1 };
    cam.position.clone.mockReturnValue(savedPos);
    cam.quaternion.clone.mockReturnValue(savedQuat);

    const handler = createSceneScreenshotHandler(deps);
    await handler({ position: [1, 2, 3], target: [0, 0, 0], fov: 60 });

    expect(cam.position.set).toHaveBeenCalledWith(1, 2, 3);
    expect(cam.lookAt).toHaveBeenCalledWith(0, 0, 0);
    expect(cam.updateProjectionMatrix).toHaveBeenCalled();
    // 復元
    expect(cam.position.copy).toHaveBeenCalledWith(savedPos);
    expect(cam.quaternion.copy).toHaveBeenCalledWith(savedQuat);
  });

  it("claim を取得して解放する", async () => {
    const { deps, claimDispose } = makeDeps();
    const handler = createSceneScreenshotHandler(deps);
    await handler({});
    expect(claimDispose).toHaveBeenCalled();
  });

  it("scene/camera/renderer が null のとき throw する", async () => {
    const { deps } = makeDeps({ camera: null });
    const handler = createSceneScreenshotHandler(deps);
    await expect(handler({})).rejects.toThrow("scene not ready");
  });

  it("toDataURL が失敗しても camera が復元される", async () => {
    const { deps, camera, canvas } = makeDeps();
    const cam = camera as unknown as {
      position: { clone: ReturnType<typeof vi.fn>; copy: ReturnType<typeof vi.fn> };
      quaternion: { clone: ReturnType<typeof vi.fn>; copy: ReturnType<typeof vi.fn> };
    };
    const savedPos = {};
    const savedQuat = {};
    cam.position.clone.mockReturnValue(savedPos);
    cam.quaternion.clone.mockReturnValue(savedQuat);

    (canvas.toDataURL as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("toDataURL failed");
    });

    const handler = createSceneScreenshotHandler(deps);
    await expect(handler({ position: [1, 2, 3] })).rejects.toThrow("toDataURL failed");
    // finally block で復元されること
    expect(cam.position.copy).toHaveBeenCalledWith(savedPos);
    expect(cam.quaternion.copy).toHaveBeenCalledWith(savedQuat);
  });
});

/**
 * MCP tool handler の pure logic テスト。
 *
 * Tauri invoke / file I/O は caller が inject する形にして、ここでは
 * merge 規則と state 更新の correctness のみ確認する。
 */

import type { SpaceEffectRequest } from "@charminal/sdk";
import type * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TweenManager } from "../../core/tween/tween-manager";
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
  createGetUiStateHandler,
  createListPacksHandler,
  createSceneCameraSetHandler,
  createSceneLightingSetHandler,
  createSetUiStateHandler,
  createSpaceEffectPlayHandler,
  createStateGetHandler,
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
      readConfig: async () => ({
        ...EMPTY_CONFIG,
        disabledPacks: ["c"],
      }),
      readLoadReport: async () => report,
    });

    const result = await handler({});
    expect(result).toEqual({
      packs: expect.arrayContaining([
        { id: "a", kind: "effect", status: "loaded" },
        { id: "b", kind: "persona", status: "loaded" },
        { id: "c", kind: "", status: "disabled" },
        { id: "broken", kind: "effect", status: "failed" },
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
      readConfig: async () => EMPTY_CONFIG,
      readLoadReport: async () => report,
    });

    const result = await handler({});
    expect(result.packs).toHaveLength(1);
    expect(result.packs[0].status).toBe("loaded");
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
    const deps = { state, getActiveUiId: () => "camera-lighting-panel" };
    const set = createSetUiStateHandler(deps);
    const get = createGetUiStateHandler(deps);

    await expect(set({ key: "camera.x", value: 1.5 })).resolves.toEqual({
      ok: true,
      packId: "camera-lighting-panel",
      key: "camera.x",
      value: 1.5,
    });
    await expect(get({ key: "camera.x" })).resolves.toEqual({
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

    const get = createGetUiStateHandler({
      state,
      getActiveUiId: () => "camera-lighting-panel",
    });
    await expect(get({})).resolves.toEqual({
      packId: "camera-lighting-panel",
      state: {
        "camera.x": 1,
        "lighting.color": "#ff8800",
      },
    });
  });

  it("rejects empty keys", async () => {
    const state = createUiStateStore();
    const deps = { state, getActiveUiId: () => "camera-lighting-panel" };
    const set = createSetUiStateHandler(deps);
    const get = createGetUiStateHandler(deps);

    await expect(set({ key: "", value: 1 })).rejects.toThrow("key must be a non-empty string");
    await expect(get({ key: "" })).rejects.toThrow("key must be a non-empty string");
  });

  it("requires value for set_ui_state but allows null", async () => {
    const state = createUiStateStore();
    const deps = { state, getActiveUiId: () => "camera-lighting-panel" };
    const set = createSetUiStateHandler(deps);
    const get = createGetUiStateHandler(deps);

    await expect(set({ key: "camera.x" })).rejects.toThrow("missing value");
    await expect(set({ key: "camera.x", value: null })).resolves.toEqual({
      ok: true,
      packId: "camera-lighting-panel",
      key: "camera.x",
      value: null,
    });
    await expect(get({ key: "camera.x" })).resolves.toEqual({
      packId: "camera-lighting-panel",
      key: "camera.x",
      value: null,
    });
  });

  it("can target a non-active UI pack explicitly", async () => {
    const state = createUiStateStore();
    const deps = { state, getActiveUiId: () => "camera-lighting-panel" };
    const set = createSetUiStateHandler(deps);
    const get = createGetUiStateHandler(deps);

    await set({ packId: "secondary-ui", key: "visible", value: true });

    await expect(get({ packId: "secondary-ui", key: "visible" })).resolves.toEqual({
      packId: "secondary-ui",
      key: "visible",
      value: true,
    });
    await expect(get({ key: "visible" })).resolves.toEqual({
      packId: "camera-lighting-panel",
      key: "visible",
      value: null,
    });
  });

  it("requires an active UI pack when packId is omitted", async () => {
    const state = createUiStateStore();
    const deps = { state, getActiveUiId: () => null };
    const set = createSetUiStateHandler(deps);
    const get = createGetUiStateHandler(deps);

    await expect(set({ key: "camera.x", value: 1 })).rejects.toThrow("no active UI pack");
    await expect(get({ key: "camera.x" })).rejects.toThrow("no active UI pack");
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
    });
    const result = await handler({});
    expect(result).toMatchObject({
      config: { primaryPersona: "p1", activeScene: "s1", terminalAgent: "claude" },
      camera: { position: [1, 2, 3], fov: 45 },
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
    });
    const result = await handler({});
    expect(result.tweens.length).toBe(1);
    expect(result.tweens[0].key).toBe("test-key");
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
  it("durationMs > 0 で tween 登録 + tweening: true", async () => {
    const tm = new TweenManager();
    const handler = createUiSidebarSetHandler({
      setSidebarWidth: () => {},
      getSidebarWidth: () => 280,
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
      tweenManager: tm,
    });
    const result = await handler({ width: 350 });
    expect(result.tweening).toBeUndefined();
    expect(setTo).toBe(350);
  });
});

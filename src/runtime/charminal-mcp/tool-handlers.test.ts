/**
 * MCP tool handler の pure logic テスト。
 *
 * Tauri invoke / file I/O は caller が inject する形にして、ここでは
 * merge 規則と state 更新の correctness のみ確認する。
 */

import type { SpaceEffectRequest } from "@charminal/sdk";
import type * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { createUiStateStore } from "../ui-state-store";
import { EMPTY_CONFIG } from "../user-pack-loader/config";
import type { LoadReport } from "../user-pack-loader/load-report";
import { UserPackRegistry } from "../user-pack-loader/user-pack-registry";
import {
  createBodyExpressionSetHandler,
  createDisablePackHandler,
  createEnablePackHandler,
  createGetUiStateHandler,
  createListPacksHandler,
  createSceneCameraSetHandler,
  createSceneLightingSetHandler,
  createSetUiStateHandler,
  createSpaceEffectPlayHandler,
  createStateGetHandler,
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
  it("aggregates config + camera + lighting + vrmLoaded", async () => {
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
    });
    const result = await handler({});
    expect(result).toMatchObject({
      config: { primaryPersona: "p1", activeScene: "s1", terminalAgent: "claude" },
      camera: { position: [1, 2, 3], fov: 45 },
      lighting: { intensity: 0.8, color: "#ffeecc" },
      vrmLoaded: true,
    });
  });

  it("handles null camera / no light / no vrm gracefully", async () => {
    const handler = createStateGetHandler({
      readConfig: vi.fn().mockResolvedValue({
        primaryPersona: null,
        activeScene: null,
        terminalAgent: "claude" as const,
      }),
      getCamera: () => null,
      getScene: () => null,
      getVrm: () => null,
    });
    const result = await handler({});
    expect(result.camera.position).toEqual([0, 0, 0]);
    expect(result.lighting.intensity).toBe(0);
    expect(result.vrmLoaded).toBe(false);
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
    });
    const result = await handler({});
    expect(result.lighting.intensity).toBe(0);
    expect(result.lighting.color).toBe("#ffffff");
  });
});

describe("createBodyExpressionSetHandler", () => {
  it("calls expressionManager.setValue with preset and intensity", async () => {
    const setValue = vi.fn();
    const handler = createBodyExpressionSetHandler({
      getVrm: () => ({ expressionManager: { setValue } }),
    });
    const result = await handler({ preset: "happy", intensity: 0.7 });
    expect(setValue).toHaveBeenCalledWith("happy", 0.7);
    expect(result).toEqual({ preset: "happy", intensity: 0.7 });
  });

  it("defaults intensity to 1 when omitted", async () => {
    const setValue = vi.fn();
    const handler = createBodyExpressionSetHandler({
      getVrm: () => ({ expressionManager: { setValue } }),
    });
    await handler({ preset: "happy" });
    expect(setValue).toHaveBeenCalledWith("happy", 1);
  });

  it("clamps intensity to 0-1 range", async () => {
    const setValue = vi.fn();
    const handler = createBodyExpressionSetHandler({
      getVrm: () => ({ expressionManager: { setValue } }),
    });
    await handler({ preset: "happy", intensity: 2 });
    expect(setValue).toHaveBeenCalledWith("happy", 1);
    await handler({ preset: "happy", intensity: -0.5 });
    expect(setValue).toHaveBeenCalledWith("happy", 0);
  });

  it("throws when VRM not loaded", async () => {
    const handler = createBodyExpressionSetHandler({
      getVrm: () => null,
    });
    await expect(handler({ preset: "happy" })).rejects.toThrow(/no VRM loaded/);
  });

  it("throws on missing preset", async () => {
    const handler = createBodyExpressionSetHandler({
      getVrm: () => ({ expressionManager: { setValue: vi.fn() } }),
    });
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
  it("sets position / target / fov when given", async () => {
    const camera = {
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
    const handler = createSceneCameraSetHandler({
      getCamera: () => camera as unknown as CameraLike,
    });
    const result = await handler({ position: [1, 2, 3], target: [4, 5, 6], fov: 30 });
    expect(camera.position.set).toHaveBeenCalledWith(1, 2, 3);
    expect(camera.lookAt).toHaveBeenCalledWith(4, 5, 6);
    expect(camera.fov).toBe(30);
    expect(camera.updateProjectionMatrix).toHaveBeenCalled();
    expect(result.fov).toBe(30);
  });

  it("throws when camera not ready", async () => {
    const handler = createSceneCameraSetHandler({ getCamera: () => null });
    await expect(handler({ position: [1, 2, 3] })).rejects.toThrow(/camera not ready/);
  });
});

describe("createSceneLightingSetHandler", () => {
  it("sets intensity and color on DirectionalLight", async () => {
    const colorSet = vi.fn();
    const light = {
      isDirectionalLight: true,
      intensity: 0.5,
      color: { set: colorSet, getHexString: () => "ff8800" },
    };
    const handler = createSceneLightingSetHandler({
      getScene: () =>
        ({
          traverse: (cb: (obj: SceneObjectLike) => void) => cb(light as unknown as SceneObjectLike),
        }) as unknown as SceneLike,
    });
    const result = await handler({ intensity: 0.9, color: "#ff8800" });
    expect(light.intensity).toBe(0.9);
    expect(colorSet).toHaveBeenCalledWith("#ff8800");
    expect(result).toEqual({ intensity: 0.9, color: "#ff8800" });
  });

  it("throws when no DirectionalLight in scene", async () => {
    const handler = createSceneLightingSetHandler({
      getScene: () =>
        ({
          traverse: (_cb: (obj: SceneObjectLike) => void) => {},
        }) as unknown as SceneLike,
    });
    await expect(handler({ intensity: 0.5 })).rejects.toThrow(/no DirectionalLight/);
  });
});

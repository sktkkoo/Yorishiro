/**
 * MCP tool handler の pure logic テスト。
 *
 * Tauri invoke / file I/O は caller が inject する形にして、ここでは
 * merge 規則と state 更新の correctness のみ確認する。
 */

import { describe, expect, it } from "vitest";
import { createUiStateStore } from "../ui-state-store";
import { EMPTY_CONFIG } from "../user-pack-loader/config";
import type { LoadReport } from "../user-pack-loader/load-report";
import { UserPackRegistry } from "../user-pack-loader/user-pack-registry";
import {
  createDisablePackHandler,
  createEnablePackHandler,
  createGetUiStateHandler,
  createListPacksHandler,
  createSetUiStateHandler,
} from "./tool-handlers";

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

    const result = (await handler({})) as unknown as { packs: Array<{ status: string }> };
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
    state.set("minimal-badge", "camera.x", 99);

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

    await set({ packId: "minimal-badge", key: "visible", value: true });

    await expect(get({ packId: "minimal-badge", key: "visible" })).resolves.toEqual({
      packId: "minimal-badge",
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

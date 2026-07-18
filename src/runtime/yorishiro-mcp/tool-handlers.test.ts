/**
 * MCP tool handler の pure logic テスト。
 *
 * Tauri invoke / file I/O は caller が inject する形にして、ここでは
 * merge 規則と state 更新の correctness のみ確認する。
 */

import type {
  PersonaDefinition,
  SpaceEffectRequest,
  UiContext,
  UiLayout,
  UiPackManifest,
} from "@yorishiro/sdk";
import type * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TweenManager } from "../../core/tween/tween-manager";
import type { SceneSpec } from "../../sdk/scene";
import type { ScenePackManifest } from "../../sdk/scene-pack";
import { AmenityPackRegistryImpl } from "../amenity-pack-registry";
import type { ManualCueResult } from "../attention-light-cue/cue-store";
import { applyCurrentProjectSceneSelection } from "../project-context/project-context";
import { ScenePackRegistryImpl } from "../scene-pack-registry/scene-pack-registry";
import { createUiPackRegistry } from "../ui-pack-registry";
import { createUiStateStore } from "../ui-state-store";
import { EMPTY_CONFIG, type YorishiroConfig } from "../user-pack-loader/config";
import type { LoadReport } from "../user-pack-loader/load-report";
import { UserPackRegistry } from "../user-pack-loader/user-pack-registry";
import {
  __resetMcpExpressionSlotsForTesting,
  __resetMcpMotionHandleForTesting,
  type BodyLike,
  type BundledExampleResponse,
  type ControlStoreLike,
  createAmenityCallHandler,
  createAmenityListToolsHandler,
  createAttentionLightCueHandler,
  createBodyAnimationPlayHandler,
  createBodyExpressionSetHandler,
  createBodyMotionCancelHandler,
  createBundledExampleReadHandler,
  createControlsGetHandler,
  createControlsSetHandler,
  createControlsSetManyHandler,
  createControlsTransitionHandler,
  createDisablePackHandler,
  createEnablePackHandler,
  createGetPackStateHandler,
  createHistoryRestoreHandler,
  createListPacksHandler,
  createLoopAnnounceHandler,
  createPackDiagnoseHandler,
  createPersonaGoodbyeSwitchHandler,
  createPersonaReflexListHandler,
  createPresenceSetIntensityHandler,
  createSceneActivateHandler,
  createSetMotionIntensityHandler,
  createSetPackStateHandler,
  createSpaceEffectPlayHandler,
  createStateGetHandler,
  createTerminalContextGetHandler,
  createTerminalRunsRecentHandler,
  createUiActivateHandler,
  createUiSidebarSetHandler,
  createUiTerminalSetHandler,
  createVoiceSayHandler,
} from "./tool-handlers";

/**
 * Three.js / VRM 型のフルセットを mock で再現するのは過剰なので、
 * test 内で必要な subset を `as unknown as <T>` で narrow する。
 */
type CameraLike = THREE.PerspectiveCamera;

function makeRun(overrides: {
  readonly id: number;
  readonly sessionId: string;
  readonly endedAt: number | null;
}) {
  return {
    id: overrides.id,
    sessionId: overrides.sessionId,
    command: `cmd-${overrides.id}`,
    cwd: null,
    status: "succeeded" as const,
    completedBy: "osc133" as const,
    exitCode: 0,
    startedAt: null,
    endedAt: overrides.endedAt,
    durationMs: null,
    startMarker: null,
    endMarker: null,
  };
}

function makeContext() {
  return {
    kind: "terminal-region-context" as const,
    sessionId: "shell-1",
    text: "captured output",
    capturedAt: 1600,
    gesture: "command-run-reference" as const,
    commandRunId: 1,
    viewport: { viewportY: 0, rows: 24, cols: 80 },
    range: { startRow: 1, endRow: 2, startCol: 0, endCol: 79 },
    rect: { x: 0, y: 0, width: 100, height: 20 },
    polygon: [],
  };
}

function makeControlStore(
  inputs: Record<string, Record<string, unknown>>,
  visiblePaths = Object.keys(inputs),
): ControlStoreLike & {
  readonly writes: Array<{ path: string; value: unknown; fromPanel: boolean }>;
} {
  const writes: Array<{ path: string; value: unknown; fromPanel: boolean }> = [];
  return {
    writes,
    getVisiblePaths: () => [...visiblePaths],
    getData: () => inputs,
    setValueAtPath: (path, value, fromPanel) => {
      writes.push({ path, value, fromPanel });
      if (inputs[path]) inputs[path].value = value;
    },
  };
}

describe("createTerminalContextGetHandler", () => {
  it("returns the latest user-pointed terminal context", async () => {
    const context = {
      kind: "terminal-region-context" as const,
      sessionId: "default-session",
      text: "build failed",
      capturedAt: 1,
      gesture: "option-shift-drag" as const,
      viewport: { viewportY: 10, rows: 24, cols: 80 },
      range: { startRow: 2, endRow: 2, startCol: 0, endCol: 11 },
      rect: { x: 10, y: 20, width: 120, height: 18 },
      polygon: [
        { x: 0, y: 0 },
        { x: 120, y: 0 },
        { x: 120, y: 18 },
      ],
    };
    const handler = createTerminalContextGetHandler({
      getLatestRegionContext: () => context,
      getTerminalReferences: () => [{ id: "default-session:Term1", context }],
    });

    await expect(handler({})).resolves.toEqual({
      context,
      references: [{ id: "default-session:Term1", context }],
    });
  });

  it("returns null when the user has not pointed at terminal text", async () => {
    const handler = createTerminalContextGetHandler({
      getLatestRegionContext: () => null,
      getTerminalReferences: () => [],
    });

    await expect(handler({})).resolves.toEqual({ context: null, references: [] });
  });
});

describe("createTerminalRunsRecentHandler", () => {
  it("returns sensitive metadata-only recent command runs", async () => {
    const handler = createTerminalRunsRecentHandler({
      getTimeline: () => [],
      getProblems: () => [{ type: "file", value: "src/foo.ts:12" }],
      getCommandRuns: () => [
        {
          id: 1,
          sessionId: "shell-1",
          command: "npm test",
          cwd: "/secret/repo",
          status: "failed",
          completedBy: "osc133",
          exitCode: 1,
          startedAt: 1000,
          endedAt: 1500,
          durationMs: 500,
          startMarker: null,
          endMarker: null,
        },
      ],
      getTerminalReferences: () => [
        {
          id: "shell-1:Term1",
          context: {
            kind: "terminal-region-context",
            sessionId: "shell-1",
            text: "output text must not be included by terminal_runs_recent",
            capturedAt: 1600,
            gesture: "command-run-reference",
            commandRunId: 1,
            viewport: { viewportY: 0, rows: 24, cols: 80 },
            range: { startRow: 1, endRow: 2, startCol: 0, endCol: 10 },
            rect: { x: 0, y: 0, width: 10, height: 10 },
            polygon: [],
          },
        },
      ],
    });

    await expect(handler({ limit: 10 })).resolves.toEqual({
      runs: [
        {
          sessionId: "shell-1",
          id: 1,
          command: "npm test",
          status: "failed",
          exitCode: 1,
          durationMs: 500,
          startedAt: 1000,
          endedAt: 1500,
          referenceIds: ["shell-1:Term1"],
          problems: [{ type: "file", value: "src/foo.ts:12" }],
        },
      ],
      timeline: [],
    });
  });

  it("keeps reference ids session-scoped when local markers collide", async () => {
    const handler = createTerminalRunsRecentHandler({
      getTimeline: () => [],
      getProblems: () => [],
      getCommandRuns: () => [
        makeRun({ id: 1, sessionId: "shell-1", endedAt: 2000 }),
        makeRun({ id: 1, sessionId: "shell-2", endedAt: 1000 }),
      ],
      getTerminalReferences: () => [
        {
          id: "shell-1:Term1",
          context: {
            ...makeContext(),
            sessionId: "shell-1",
            commandRunId: 1,
          },
        },
        {
          id: "shell-2:Term1",
          context: {
            ...makeContext(),
            sessionId: "shell-2",
            commandRunId: 1,
          },
        },
      ],
    });

    const result = await handler({ limit: 10 });

    expect(result.runs.map((run) => [run.sessionId, run.referenceIds])).toEqual([
      ["shell-1", ["shell-1:Term1"]],
      ["shell-2", ["shell-2:Term1"]],
    ]);
  });

  it("clamps limit and sorts newest first", async () => {
    const handler = createTerminalRunsRecentHandler({
      getTimeline: () => [],
      getProblems: () => [],
      getCommandRuns: () => [
        makeRun({ id: 1, sessionId: "shell-1", endedAt: 1000 }),
        makeRun({ id: 2, sessionId: "shell-1", endedAt: 3000 }),
        makeRun({ id: 3, sessionId: "shell-1", endedAt: 2000 }),
      ],
      getTerminalReferences: () => [],
    });

    const result = await handler({ limit: 2.8 });

    expect(result.runs.map((run) => run.id)).toEqual([2, 3]);
  });
});

describe("createLoopAnnounceHandler", () => {
  it("ingests a valid phase with host-stamped agent and detail", async () => {
    const ingested: Array<{ phase: string; agent: string | null; detail: unknown }> = [];
    const handler = createLoopAnnounceHandler({
      ingest: (phase, agent, detail) => ingested.push({ phase, agent, detail }),
      getAgentKind: () => "codex",
    });

    await expect(
      handler({ phase: "blocked-on-approval", detail: { reason: "destructive op" } }),
    ).resolves.toEqual({ announced: true });
    expect(ingested).toEqual([
      { phase: "blocked-on-approval", agent: "codex", detail: { reason: "destructive op" } },
    ]);
  });

  it("normalizes omitted (SDK) and explicit-null (Rust transport) detail to undefined", async () => {
    const ingested: Array<{ phase: string; agent: string | null; detail: unknown }> = [];
    const handler = createLoopAnnounceHandler({
      ingest: (phase, agent, detail) => ingested.push({ phase, agent, detail }),
      getAgentKind: () => "claude",
    });

    // SDK 経路: ctx.loop.announce(phase) → detail key 省略
    await handler({ phase: "started" });
    // MCP/Rust 経路: emit_to の json!({ "detail": req.detail }) が Option::None を null で送る
    await handler({ phase: "completed", detail: null });

    expect(ingested).toEqual([
      { phase: "started", agent: "claude", detail: undefined },
      { phase: "completed", agent: "claude", detail: undefined },
    ]);
  });

  it("rejects an unknown phase without ingesting", async () => {
    const ingested: unknown[] = [];
    const handler = createLoopAnnounceHandler({
      ingest: (...args) => ingested.push(args),
      getAgentKind: () => "claude",
    });

    await expect(handler({ phase: "not-a-phase" })).resolves.toEqual({ announced: false });
    await expect(handler({})).resolves.toEqual({ announced: false });
    expect(ingested).toHaveLength(0);
  });
});

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

  it("marks isActive based on getActiveIds for multi-active kinds", async () => {
    const registry = new UserPackRegistry();
    registry.register("user-ambient", "ambient-ui", { dispose: () => {} });
    registry.register("user-amenity", "amenity", { dispose: () => {} });

    const handler = createListPacksHandler({
      readRegistry: () => registry.listEntries(),
      readBundledPacks: () => [
        { id: "bundled-ambient", kind: "ambient-ui" },
        { id: "bundled-amenity", kind: "amenity" },
      ],
      readConfig: async () => EMPTY_CONFIG,
      readLoadReport: async () => null,
      getActiveIds: () => ({
        scene: null,
        ui: null,
        persona: null,
        ambientUi: ["user-ambient"],
        amenity: ["bundled-amenity"],
      }),
    });

    const result = await handler({});
    const byId = new Map(result.packs.map((p) => [`${p.kind}:${p.id}`, p]));
    expect(byId.get("ambient-ui:user-ambient")?.isActive).toBe(true);
    expect(byId.get("ambient-ui:bundled-ambient")?.isActive).toBe(false);
    expect(byId.get("amenity:user-amenity")?.isActive).toBe(false);
    expect(byId.get("amenity:bundled-amenity")?.isActive).toBe(true);
  });
});

describe("pack_diagnose handler", () => {
  it("returns loaded status, manifest summary, and active state for a user pack", async () => {
    const registry = new UserPackRegistry();
    registry.register("user-scene", "scene", { dispose: () => {} });

    const handler = createPackDiagnoseHandler({
      readRegistry: () => registry.listEntries(),
      readBundledPacks: () => [],
      readConfig: async () => EMPTY_CONFIG,
      readLoadReport: async () => null,
      getActiveIds: () => ({ scene: "user-scene", ui: null, persona: null }),
      readUserPackEntries: async () => [
        {
          id: "user-scene",
          kind: "scene",
          entryPath: "/Users/me/.yorishiro/packs/user-scene/scene.js",
          source: "local",
          manifest: {
            id: "user-scene",
            type: "scene",
            entry: "scene.js",
            executionClass: "trusted-main-thread-js",
          },
        },
      ],
    });

    const result = await handler({ id: "user-scene" });

    expect(result.ok).toBe(true);
    expect(result.diagnoses).toEqual([
      {
        id: "user-scene",
        kind: "scene",
        origin: "user",
        status: "loaded",
        isActive: true,
        entryPath: "/Users/me/.yorishiro/packs/user-scene/scene.js",
        manifest: {
          id: "user-scene",
          type: "scene",
          entry: "scene.js",
          executionClass: "trusted-main-thread-js",
        },
      },
    ]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        {
          severity: "info",
          code: "pack-loaded",
          message: "scene pack 'user-scene' is loaded and active",
        },
        {
          severity: "info",
          code: "local-trusted-code",
          message: "pack 'user-scene' runs as local trusted code",
        },
      ]),
    );
  });

  it("returns active state for a loaded ambient-ui pack", async () => {
    const registry = new UserPackRegistry();
    registry.register("work-context-lite", "ambient-ui", { dispose: () => {} });

    const handler = createPackDiagnoseHandler({
      readRegistry: () => registry.listEntries(),
      readBundledPacks: () => [],
      readConfig: async () => EMPTY_CONFIG,
      readLoadReport: async () => null,
      getActiveIds: () => ({
        scene: null,
        ui: null,
        persona: null,
        ambientUi: ["work-context-lite"],
      }),
      readUserPackEntries: async () => [
        {
          id: "work-context-lite",
          kind: "ambient-ui",
          entryPath: "/Users/me/.yorishiro/packs/work-context-lite/ambient-ui.js",
          source: "local",
          manifest: {
            id: "work-context-lite",
            type: "ambient-ui",
            entry: "ambient-ui.js",
            executionClass: "trusted-main-thread-js",
          },
        },
      ],
    });

    const result = await handler({ id: "work-context-lite" });

    expect(result.ok).toBe(true);
    expect(result.diagnoses[0]).toMatchObject({
      id: "work-context-lite",
      kind: "ambient-ui",
      status: "loaded",
      isActive: true,
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        {
          severity: "info",
          code: "pack-loaded",
          message: "ambient-ui pack 'work-context-lite' is loaded and active",
        },
      ]),
    );
  });

  it("returns load failure details from the latest load report", async () => {
    const report: LoadReport = {
      timestamp: "2026-04-18T00:00:00.000Z",
      safeMode: false,
      loadResults: [
        {
          id: "broken",
          kind: "effect",
          status: "failed",
          error: { phase: "validate", message: "module has no default export" },
        },
      ],
    };

    const handler = createPackDiagnoseHandler({
      readRegistry: () => [],
      readBundledPacks: () => [],
      readConfig: async () => EMPTY_CONFIG,
      readLoadReport: async () => report,
      getActiveIds: () => ({ scene: null, ui: null, persona: null }),
      readUserPackEntries: async () => [],
    });

    const result = await handler({ id: "broken" });

    expect(result.ok).toBe(false);
    expect(result.diagnoses).toEqual([
      {
        id: "broken",
        kind: "effect",
        origin: "user",
        status: "failed",
        isActive: false,
        loadError: { phase: "validate", message: "module has no default export" },
      },
    ]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        {
          severity: "error",
          code: "pack-load-failed",
          message: "module has no default export",
        },
      ]),
    );
  });

  it("flags disabled packs", async () => {
    const handler = createPackDiagnoseHandler({
      readRegistry: () => [],
      readBundledPacks: () => [],
      readConfig: async () => ({ ...EMPTY_CONFIG, disabledPacks: ["missing"] }),
      readLoadReport: async () => null,
      getActiveIds: () => ({ scene: null, ui: null, persona: null }),
      readUserPackEntries: async () => [],
    });

    const result = await handler({ id: "missing" });

    expect(result.ok).toBe(true);
    expect(result.diagnoses).toEqual([
      {
        id: "missing",
        kind: "",
        origin: "user",
        status: "disabled",
        isActive: false,
      },
    ]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        {
          severity: "info",
          code: "pack-disabled",
          message: "pack 'missing' is listed in config.disabledPacks",
        },
      ]),
    );
  });

  it("flags missing packs", async () => {
    const handler = createPackDiagnoseHandler({
      readRegistry: () => [],
      readBundledPacks: () => [],
      readConfig: async () => EMPTY_CONFIG,
      readLoadReport: async () => null,
      getActiveIds: () => ({ scene: null, ui: null, persona: null }),
      readUserPackEntries: async () => [],
    });

    const result = await handler({ id: "missing" });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        {
          severity: "error",
          code: "pack-not-found",
          message: "pack 'missing' was not found",
        },
      ]),
    );
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
      updateConfig: async (update) => {
        const next = update(EMPTY_CONFIG);
        writtenConfig = JSON.stringify(next);
        return next;
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

  it("disables bundled amenity entries through the injected hook", async () => {
    let disabledBundled: string | null = null;
    const handler = createDisablePackHandler({
      updateConfig: async (update) => update(EMPTY_CONFIG),
      registry: new UserPackRegistry(),
      disableBundledAmenity: (id) => {
        disabledBundled = id;
        return true;
      },
    });

    const result = await handler({ id: "music-shelf" });
    expect(result).toEqual({ ok: true });
    expect(disabledBundled).toBe("music-shelf");
  });

  it("is idempotent when id is already disabled", async () => {
    const handler = createDisablePackHandler({
      updateConfig: async (update) =>
        update({
          ...EMPTY_CONFIG,
          disabledPacks: ["already"],
        }),
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
      updateConfig: async (update) => {
        const next = update({
          ...EMPTY_CONFIG,
          disabledPacks: ["a", "target", "b"],
        });
        writtenConfig = { disabledPacks: Array.from(next.disabledPacks) };
        return next;
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
      updateConfig: async (update) => update(EMPTY_CONFIG),
      reloadPack: async () => ({ ok: false, reason: "pack file not found" }),
    });
    const result = await handler({ id: "ghost" });
    expect(result).toEqual({ ok: false, reason: "pack file not found" });
  });

  it("enables bundled amenities without falling through to user pack reload", async () => {
    let reloadCalled = false;
    const handler = createEnablePackHandler({
      updateConfig: async (update) => update(EMPTY_CONFIG),
      reloadPack: async () => {
        reloadCalled = true;
        return { ok: false, reason: "pack file not found" };
      },
      enableBundledAmenity: (id) => id === "music-shelf",
    });

    const result = await handler({ id: "music-shelf" });
    expect(result).toEqual({ ok: true });
    expect(reloadCalled).toBe(false);
  });
});

describe("createHistoryRestoreHandler", () => {
  it("surfaces a restore proposal and returns ok immediately", async () => {
    const proposed: number[] = [];
    const handler = createHistoryRestoreHandler({
      proposeRestore: (seq) => {
        proposed.push(seq);
      },
    });
    expect(await handler({ seq: 3 })).toEqual({ ok: true });
    expect(proposed).toEqual([3]);
  });

  it("rejects invalid seq without proposing restore", async () => {
    const proposeRestore = vi.fn();
    const handler = createHistoryRestoreHandler({
      proposeRestore,
    });
    expect(await handler({})).toEqual({ ok: false, reason: "missing or invalid seq" });
    expect(proposeRestore).not.toHaveBeenCalled();
  });
});

describe("amenity_call / amenity_list_tools", () => {
  const makeRegistry = () => {
    const reg = new AmenityPackRegistryImpl();
    reg.register({
      id: "noted",
      origin: "user",
      manifest: {
        id: "noted",
        type: "amenity",
        version: "0.0.0",
        yorishiroVersion: "*",
        entry: "amenity.js",
      },
      handle: { tools: { noted_add: async (p) => ({ saved: p }) }, dispose: () => {} },
    });
    reg.enable("noted");
    return reg;
  };

  it("routes amenity_call to the active handle's tool", async () => {
    const handler = createAmenityCallHandler({ amenityPackRegistry: makeRegistry() });
    expect(await handler({ amenityId: "noted", tool: "noted_add", params: { t: 1 } })).toEqual({
      saved: { t: 1 },
    });
  });

  it("throws on unknown amenity or tool", async () => {
    const handler = createAmenityCallHandler({ amenityPackRegistry: makeRegistry() });
    await expect(handler({ amenityId: "ghost", tool: "x" })).rejects.toThrow();
    await expect(handler({ amenityId: "noted", tool: "nope" })).rejects.toThrow();
  });

  it("lists active amenity tool names (and treats null amenityId as no filter)", async () => {
    const handler = createAmenityListToolsHandler({ amenityPackRegistry: makeRegistry() });
    const expected = { amenities: [{ id: "noted", tools: ["noted_add"] }] };
    expect(await handler({})).toEqual(expected);
    // MCP は省略時に {"amenityId": null} を送るため、全件として扱う。
    expect(await handler({ amenityId: null })).toEqual(expected);
  });
});

describe("ui_state handlers", () => {
  it("sets and gets a single UI state key", async () => {
    const state = createUiStateStore();
    const packId = "camera-lighting-panel";
    const set = createSetPackStateHandler({ state, getActiveSceneId: () => packId });
    const get = createGetPackStateHandler({ state, getActiveSceneId: () => packId });

    await expect(set({ key: "camera.x", value: 1.5 })).resolves.toEqual({
      ok: true,
      packId,
      key: "camera.x",
      value: 1.5,
    });
    await expect(get({ key: "camera.x" })).resolves.toEqual({
      packId,
      key: "camera.x",
      value: 1.5,
    });
  });

  it("returns the full UI state snapshot when key is omitted", async () => {
    const state = createUiStateStore();
    state.set("camera-lighting-panel", "camera.x", 1);
    state.set("camera-lighting-panel", "lighting.color", "#ff8800");
    state.set("secondary-ui", "camera.x", 99);

    const get = createGetPackStateHandler({
      state,
      getActiveSceneId: () => "camera-lighting-panel",
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
    const set = createSetPackStateHandler({ state, getActiveSceneId: () => "test" });
    const get = createGetPackStateHandler({ state, getActiveSceneId: () => "test" });

    await expect(set({ key: "", value: 1 })).rejects.toThrow("key must be a non-empty string");
    await expect(get({ key: "" })).rejects.toThrow("key must be a non-empty string");
  });

  it("requires value for set_ui_state but allows null", async () => {
    const state = createUiStateStore();
    const set = createSetPackStateHandler({ state, getActiveSceneId: () => "test" });
    const get = createGetPackStateHandler({ state, getActiveSceneId: () => "test" });

    await expect(set({ key: "camera.x" })).rejects.toThrow("missing value");
    await expect(set({ key: "camera.x", value: null })).resolves.toEqual({
      ok: true,
      packId: "test",
      key: "camera.x",
      value: null,
    });
    await expect(get({ key: "camera.x" })).resolves.toEqual({
      packId: "test",
      key: "camera.x",
      value: null,
    });
  });

  it("pack state は pack ごとに分離されている", async () => {
    const state = createUiStateStore();
    let activeScene = "pack-a";
    const set = createSetPackStateHandler({ state, getActiveSceneId: () => activeScene });
    const get = createGetPackStateHandler({ state, getActiveSceneId: () => activeScene });

    await set({ key: "visible", value: true });
    activeScene = "pack-b";
    await set({ key: "visible", value: false });

    activeScene = "pack-a";
    await expect(get({ key: "visible" })).resolves.toEqual({
      packId: "pack-a",
      key: "visible",
      value: true,
    });
    activeScene = "pack-b";
    await expect(get({ key: "visible" })).resolves.toEqual({
      packId: "pack-b",
      key: "visible",
      value: false,
    });
  });

  it("set_ui_state は packId 省略時に active scene で fallback", async () => {
    const state = createUiStateStore();
    const set = createSetPackStateHandler({ state, getActiveSceneId: () => "my-scene" });

    await expect(set({ key: "color", value: "#00ff00" })).resolves.toEqual({
      ok: true,
      packId: "my-scene",
      key: "color",
      value: "#00ff00",
    });
    expect(state.get("my-scene", "color")).toBe("#00ff00");
  });

  it("set_ui_state は packId 省略 + active scene なしでエラー", async () => {
    const state = createUiStateStore();
    const set = createSetPackStateHandler({ state, getActiveSceneId: () => null });

    await expect(set({ key: "color", value: "#ff0000" })).rejects.toThrow(
      "active な scene pack がありません",
    );
  });

  it("get_ui_state は packId 省略時に active scene で fallback", async () => {
    const state = createUiStateStore();
    state.set("my-scene", "color", "#ff0000");
    const get = createGetPackStateHandler({
      state,
      getActiveSceneId: () => "my-scene",
    });

    await expect(get({ key: "color" })).resolves.toEqual({
      packId: "my-scene",
      key: "color",
      value: "#ff0000",
    });
  });

  it("get_ui_state は packId 省略 + active scene なしでエラー", async () => {
    const state = createUiStateStore();
    const get = createGetPackStateHandler({
      state,
      getActiveSceneId: () => null,
    });

    await expect(get({ key: "color" })).rejects.toThrow("active な scene pack がありません");
  });
});

describe("controls handlers", () => {
  it("reads active scene controls as normalized entries", async () => {
    const sceneStore = makeControlStore({
      "lights.intensity": {
        type: "NUMBER",
        value: 0.8,
        label: "light int.",
        disabled: false,
      },
      "post effects.bloom.amount": {
        type: "NUMBER",
        value: 1.2,
        label: "amount",
        disabled: false,
      },
    });
    const get = createControlsGetHandler({
      getSceneStore: () => sceneStore,
      getCommonStore: () => null,
      getActiveSceneId: () => "simple-room",
    });

    await expect(get({ scope: "scene" })).resolves.toEqual({
      scope: "scene",
      activeSceneId: "simple-room",
      controls: [
        {
          path: "lights.intensity",
          value: 0.8,
          type: "NUMBER",
          label: "light int.",
          disabled: false,
        },
        {
          path: "post effects.bloom.amount",
          value: 1.2,
          type: "NUMBER",
          label: "amount",
          disabled: false,
        },
      ],
    });
  });

  it("reads and writes common controls", async () => {
    const commonStore = makeControlStore({
      "camera.lookAtCharacter": {
        type: "BOOLEAN",
        value: true,
        label: "look at character",
        disabled: false,
      },
    });
    const deps = {
      getSceneStore: () => null,
      getCommonStore: () => commonStore,
      getActiveSceneId: () => null,
    };
    const get = createControlsGetHandler(deps);
    const set = createControlsSetHandler(deps);

    await expect(get({ scope: "common", path: "camera.lookAtCharacter" })).resolves.toEqual({
      scope: "common",
      activeSceneId: undefined,
      control: {
        path: "camera.lookAtCharacter",
        value: true,
        type: "BOOLEAN",
        label: "look at character",
        disabled: false,
      },
    });
    await expect(
      set({ scope: "common", path: "camera.lookAtCharacter", value: false }),
    ).resolves.toEqual({
      ok: true,
      scope: "common",
      activeSceneId: undefined,
      path: "camera.lookAtCharacter",
      value: false,
    });
    expect(commonStore.writes).toEqual([
      { path: "camera.lookAtCharacter", value: false, fromPanel: false },
    ]);
    await expect(get({ scope: "common", path: "camera.lookAtCharacter" })).resolves.toMatchObject({
      control: { value: false },
    });
  });

  it("runs a side effect after a successful controls.set", async () => {
    const commonStore = makeControlStore({
      "camera.x": {
        type: "NUMBER",
        value: 0,
        label: "x",
        disabled: false,
      },
    });
    const sideEffects: Array<{ scope: string; path: string; value: unknown }> = [];
    const set = createControlsSetHandler({
      getSceneStore: () => null,
      getCommonStore: () => commonStore,
      getActiveSceneId: () => null,
      onControlSet: (event) => sideEffects.push(event),
    });

    await expect(set({ scope: "common", path: "camera.x", value: 1.25 })).resolves.toMatchObject({
      ok: true,
      scope: "common",
      path: "camera.x",
      value: 1.25,
    });
    expect(commonStore.writes).toEqual([{ path: "camera.x", value: 1.25, fromPanel: false }]);
    expect(sideEffects).toEqual([{ scope: "common", path: "camera.x", value: 1.25 }]);
  });

  it("writes multiple controls at once", async () => {
    const sceneStore = makeControlStore({
      "lights.intensity": {
        type: "NUMBER",
        value: 0.8,
        label: "light int.",
        disabled: false,
      },
      "post effects.bloom.amount": {
        type: "NUMBER",
        value: 1.2,
        label: "amount",
        disabled: false,
      },
    });
    const setMany = createControlsSetManyHandler({
      getSceneStore: () => sceneStore,
      getCommonStore: () => null,
      getActiveSceneId: () => "simple-room",
    });

    await expect(
      setMany({
        scope: "scene",
        values: {
          "lights.intensity": 0.5,
          "post effects.bloom.amount": 0.1,
        },
      }),
    ).resolves.toEqual({
      ok: true,
      scope: "scene",
      activeSceneId: "simple-room",
      values: {
        "lights.intensity": 0.5,
        "post effects.bloom.amount": 0.1,
      },
    });
    expect(sceneStore.writes).toEqual([
      { path: "lights.intensity", value: 0.5, fromPanel: false },
      { path: "post effects.bloom.amount", value: 0.1, fromPanel: false },
    ]);
  });

  it("transitions numeric controls and applies nonnumeric controls immediately", async () => {
    const tm = new TweenManager();
    const commonStore = makeControlStore({
      "camera.x": {
        type: "NUMBER",
        value: 0,
        label: "x",
        disabled: false,
      },
      "camera.tracking": {
        type: "BOOLEAN",
        value: true,
        label: "tracking",
        disabled: false,
      },
    });
    const sideEffects: Array<{ scope: string; path: string; value: unknown }> = [];
    const transition = createControlsTransitionHandler({
      getSceneStore: () => null,
      getCommonStore: () => commonStore,
      getActiveSceneId: () => null,
      tweenManager: tm,
      onControlSet: (event) => sideEffects.push(event),
    });

    await expect(
      transition({
        scope: "common",
        durationMs: 100,
        values: {
          "camera.tracking": false,
          "camera.x": 10,
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      scope: "common",
      durationMs: 100,
      tweening: true,
    });

    expect(commonStore.writes).toEqual([
      { path: "camera.tracking", value: false, fromPanel: false },
    ]);
    tm.tick(0);
    tm.tick(50);
    tm.tick(100);

    expect(commonStore.writes).toEqual([
      { path: "camera.tracking", value: false, fromPanel: false },
      { path: "camera.x", value: 0, fromPanel: false },
      { path: "camera.x", value: 5, fromPanel: false },
      { path: "camera.x", value: 10, fromPanel: false },
    ]);
    expect(sideEffects).toEqual([
      { scope: "common", path: "camera.tracking", value: false },
      { scope: "common", path: "camera.x", value: 0 },
      { scope: "common", path: "camera.x", value: 5 },
      { scope: "common", path: "camera.x", value: 10 },
    ]);
  });

  it("transitions hex color controls through intermediate values", async () => {
    const tm = new TweenManager();
    const sceneStore = makeControlStore({
      "lights.ambientColor": {
        type: "COLOR",
        value: "#000000",
        label: "ambient color",
        disabled: false,
      },
    });
    const transition = createControlsTransitionHandler({
      getSceneStore: () => sceneStore,
      getCommonStore: () => null,
      getActiveSceneId: () => "simple-room",
      tweenManager: tm,
    });

    await expect(
      transition({
        scope: "scene",
        durationMs: 100,
        values: { "lights.ambientColor": "#ffffff" },
      }),
    ).resolves.toMatchObject({ ok: true, scope: "scene", durationMs: 100, tweening: true });

    tm.tick(0);
    tm.tick(50);
    tm.tick(100);

    expect(sceneStore.writes).toEqual([
      { path: "lights.ambientColor", value: "#000000", fromPanel: false },
      { path: "lights.ambientColor", value: "#808080", fromPanel: false },
      { path: "lights.ambientColor", value: "#ffffff", fromPanel: false },
    ]);
  });

  it("applies non-hex string controls immediately without tweening", async () => {
    const tm = new TweenManager();
    const sceneStore = makeControlStore({
      "scene layers.backgroundFile": {
        type: "STRING",
        value: "(none)",
        label: "bg media",
        disabled: false,
      },
    });
    const transition = createControlsTransitionHandler({
      getSceneStore: () => sceneStore,
      getCommonStore: () => null,
      getActiveSceneId: () => "simple-room",
      tweenManager: tm,
    });

    await expect(
      transition({
        scope: "scene",
        durationMs: 100,
        values: { "scene layers.backgroundFile": "room.png" },
      }),
    ).resolves.toMatchObject({ ok: true, tweening: false });

    expect(sceneStore.writes).toEqual([
      { path: "scene layers.backgroundFile", value: "room.png", fromPanel: false },
    ]);
  });

  it("controls.set cancels active transitions on the same path", async () => {
    const tm = new TweenManager();
    const commonStore = makeControlStore({
      "camera.x": {
        type: "NUMBER",
        value: 0,
        label: "x",
        disabled: false,
      },
    });
    const deps = {
      getSceneStore: () => null,
      getCommonStore: () => commonStore,
      getActiveSceneId: () => null,
      tweenManager: tm,
    };
    const transition = createControlsTransitionHandler(deps);
    const set = createControlsSetHandler(deps);

    await transition({ scope: "common", durationMs: 100, values: { "camera.x": 10 } });
    expect(tm.isActive("controls.common.camera.x")).toBe(true);
    await set({ scope: "common", path: "camera.x", value: 2 });
    expect(tm.isActive("controls.common.camera.x")).toBe(false);
  });

  it("defaults scope to scene and rejects missing active scene", async () => {
    const get = createControlsGetHandler({
      getSceneStore: () => null,
      getCommonStore: () => null,
      getActiveSceneId: () => null,
    });

    await expect(get({})).rejects.toThrow("active な scene pack がありません");
  });

  it("rejects unknown control paths", async () => {
    const sceneStore = makeControlStore({
      "lights.intensity": {
        type: "NUMBER",
        value: 0.8,
        label: "light int.",
        disabled: false,
      },
    });
    const set = createControlsSetHandler({
      getSceneStore: () => sceneStore,
      getCommonStore: () => null,
      getActiveSceneId: () => "simple-room",
    });

    await expect(set({ path: "lights.missing", value: 1 })).rejects.toThrow(
      "control path not found: lights.missing",
    );
  });
});

/** テスト用のデフォルト presenceSnapshot。 */
const defaultPresenceSnapshot = () => ({
  level: "full" as const,
  levelSince: 0,
  previousLevel: null,
  previousLevelSince: null,
  source: "default" as const,
});

describe("createStateGetHandler", () => {
  it("aggregates config + camera + vrmLoaded + expressions", async () => {
    const handler = createStateGetHandler({
      readConfig: vi.fn().mockResolvedValue({
        primaryPersona: "p1",
        activeScene: "s1",
        terminalAgent: "claude" as const,
      }),
      getCamera: () => ({ position: { x: 1, y: 2, z: 3 }, fov: 45 }) as unknown as CameraLike,
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
      getCameraModulationState: () => ({ enabled: true, suspended: false, activeKeys: [] }),
      getEffectKinds: () => [],
      getRuntimeActive: () => ({ scene: null, ui: null }),
      getPresenceSnapshot: defaultPresenceSnapshot,
      getActiveSceneId: () => null,
      uiState: createUiStateStore(),
    });
    const result = await handler({});
    expect(result).toMatchObject({
      config: { primaryPersona: "p1", activeScene: "s1", terminalAgent: "claude" },
      camera: { position: [1, 2, 3], fov: 45, tracking: true },
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
      getVrm: () => null,
      getBody: () => null,
      tweenManager: new TweenManager(),
      getSidebarWidth: () => 280,
      getTerminalOpacity: () => 1,
      getSceneLayerValues: () => ({ blur: 0, opacity: 1 }),
      getCameraTracking: () => true,
      getCameraModulationState: () => ({ enabled: true, suspended: false, activeKeys: [] }),
      getEffectKinds: () => [],
      getRuntimeActive: () => ({ scene: null, ui: null }),
      getPresenceSnapshot: defaultPresenceSnapshot,
      getActiveSceneId: () => null,
      uiState: createUiStateStore(),
    });
    const result = await handler({});
    expect(result.camera.position).toEqual([0, 0, 0]);
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
      getCameraModulationState: () => ({ enabled: true, suspended: false, activeKeys: [] }),
      getEffectKinds: () => [],
      getRuntimeActive: () => ({ scene: null, ui: null }),
      getPresenceSnapshot: defaultPresenceSnapshot,
      getActiveSceneId: () => null,
      uiState: createUiStateStore(),
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
      getVrm: () => null,
      getBody: () => null,
      tweenManager: new TweenManager(),
      getSidebarWidth: () => 280,
      getTerminalOpacity: () => 1,
      getSceneLayerValues: () => ({ blur: 0, opacity: 1 }),
      getCameraTracking: () => true,
      getCameraModulationState: () => ({ enabled: true, suspended: false, activeKeys: [] }),
      getEffectKinds: () => [],
      getRuntimeActive: () => ({ scene: null, ui: null }),
      getPresenceSnapshot: defaultPresenceSnapshot,
      getActiveSceneId: () => null,
      uiState: createUiStateStore(),
    });
    const result = await handler({});
    expect(result.expressions).toEqual([]);
  });

  it("ui section を返す", async () => {
    const handler = createStateGetHandler({
      readConfig: async () => ({
        primaryPersona: null,
        activeScene: null,
        sceneByProject: {},
        terminalAgent: "claude" as const,
        disabledPacks: [],
        ambientAudioMuted: false,
        ambientAudioVolume: 1,
        attentionLightNotifications: true,
        motionIntensity: 1,
        mcpPort: null,
        projectFolder: null,
        activeUi: null,
        activeAmbientUi: [],
        tabMetadataBadges: false,
        language: "auto",
        profiles: [],
        defaultProfile: null,
        voiceFrequency: "on" as const,
        mediaFolders: ["~/Music"],
      }),
      getCamera: () => null,
      getVrm: () => null,
      getBody: () => null,
      tweenManager: new TweenManager(),
      getSidebarWidth: () => 350,
      getTerminalOpacity: () => 0.7,
      getSceneLayerValues: (role) =>
        role === "background" ? { blur: 5, opacity: 0.8 } : { blur: 0, opacity: 1 },
      getCameraTracking: () => true,
      getCameraModulationState: () => ({ enabled: true, suspended: false, activeKeys: [] }),
      getEffectKinds: () => [],
      getRuntimeActive: () => ({ scene: null, ui: null }),
      getPresenceSnapshot: defaultPresenceSnapshot,
      getActiveSceneId: () => null,
      uiState: createUiStateStore(),
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
        sceneByProject: {},
        terminalAgent: "claude" as const,
        disabledPacks: [],
        ambientAudioMuted: false,
        ambientAudioVolume: 1,
        attentionLightNotifications: true,
        motionIntensity: 1,
        mcpPort: null,
        projectFolder: null,
        activeUi: null,
        activeAmbientUi: [],
        tabMetadataBadges: false,
        language: "auto",
        profiles: [],
        defaultProfile: null,
        voiceFrequency: "on" as const,
        mediaFolders: ["~/Music"],
      }),
      getCamera: () => null,
      getVrm: () => null,
      getBody: () => null,
      tweenManager: tm,
      getSidebarWidth: () => 280,
      getTerminalOpacity: () => 1,
      getSceneLayerValues: () => ({ blur: 0, opacity: 1 }),
      getCameraTracking: () => true,
      getCameraModulationState: () => ({ enabled: true, suspended: false, activeKeys: [] }),
      getEffectKinds: () => [],
      getRuntimeActive: () => ({ scene: null, ui: null }),
      getPresenceSnapshot: defaultPresenceSnapshot,
      getActiveSceneId: () => null,
      uiState: createUiStateStore(),
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
      getVrm: () => null,
      getBody: () => null,
      tweenManager: new TweenManager(),
      getSidebarWidth: () => 280,
      getTerminalOpacity: () => 1,
      getSceneLayerValues: () => ({ blur: 0, opacity: 1 }),
      getCameraTracking: () => false,
      getCameraModulationState: () => ({ enabled: true, suspended: false, activeKeys: [] }),
      getEffectKinds: () => [],
      getRuntimeActive: () => ({
        scene: "runtime-scene", // divergence: registry が config と違う
        ui: "runtime-ui",
      }),
      getPresenceSnapshot: defaultPresenceSnapshot,
      getActiveSceneId: () => "runtime-scene",
      uiState: createUiStateStore(),
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

  afterEach(() => {
    vi.useRealTimers();
    __resetMcpExpressionSlotsForTesting();
  });

  it("acquires expression slot via Body.acquireExpressionSlot with mcp source / mood kind", async () => {
    const { body, acquireExpressionSlot } = makeMockBody();
    const handler = createBodyExpressionSetHandler({ getBody: () => body });
    const result = await handler({ preset: "happy", intensity: 0.7 });
    expect(acquireExpressionSlot).toHaveBeenCalledWith("mcp", "mood", "happy", 0.7);
    expect(result).toEqual({
      preset: "happy",
      intensity: 0.7,
      durationMs: 1500,
      transient: true,
    });
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
    expect(result).toEqual({
      preset: "happy",
      intensity: 0,
      durationMs: null,
      transient: false,
    });
  });

  it("defaults to transient expression and releases after 1500ms", async () => {
    vi.useFakeTimers();
    const { body, handles } = makeMockBody();
    const handler = createBodyExpressionSetHandler({ getBody: () => body });

    await handler({ preset: "happy", intensity: 0.5 });
    expect(handles[0].release).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1499);
    expect(handles[0].release).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(handles[0].release).toHaveBeenCalledTimes(1);
  });

  it("uses requested durationMs for transient expression", async () => {
    vi.useFakeTimers();
    const { body, handles } = makeMockBody();
    const handler = createBodyExpressionSetHandler({ getBody: () => body });

    const result = await handler({ preset: "happy", intensity: 0.5, durationMs: 250 });
    expect(result).toEqual({
      preset: "happy",
      intensity: 0.5,
      durationMs: 250,
      transient: true,
    });

    vi.advanceTimersByTime(249);
    expect(handles[0].release).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(handles[0].release).toHaveBeenCalledTimes(1);
  });

  it("durationMs 0 keeps the expression until explicitly released", async () => {
    vi.useFakeTimers();
    const { body, handles } = makeMockBody();
    const handler = createBodyExpressionSetHandler({ getBody: () => body });

    const result = await handler({ preset: "happy", intensity: 0.5, durationMs: 0 });
    expect(result).toEqual({
      preset: "happy",
      intensity: 0.5,
      durationMs: null,
      transient: false,
    });

    vi.advanceTimersByTime(10_000);
    expect(handles[0].release).not.toHaveBeenCalled();

    await handler({ preset: "happy", intensity: 0 });
    expect(handles[0].release).toHaveBeenCalledTimes(1);
  });

  it("hold true keeps the expression until explicitly released", async () => {
    vi.useFakeTimers();
    const { body, handles } = makeMockBody();
    const handler = createBodyExpressionSetHandler({ getBody: () => body });

    const result = await handler({ preset: "sad", intensity: 0.5, hold: true });
    expect(result).toEqual({
      preset: "sad",
      intensity: 0.5,
      durationMs: null,
      transient: false,
    });

    vi.advanceTimersByTime(10_000);
    expect(handles[0].release).not.toHaveBeenCalled();
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

  it("does not let an old transient timer release a newer expression", async () => {
    vi.useFakeTimers();
    const { body, handles } = makeMockBody();
    const handler = createBodyExpressionSetHandler({ getBody: () => body });

    await handler({ preset: "happy", intensity: 0.5, durationMs: 1000 });
    await handler({ preset: "sad", intensity: 0.5, durationMs: 1000 });
    expect(handles[0].release).toHaveBeenCalledTimes(1);
    expect(handles[1].release).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(handles[0].release).toHaveBeenCalledTimes(1);
    expect(handles[1].release).toHaveBeenCalledTimes(1);
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

  it("parses payload when it arrives as a JSON string", async () => {
    // MCP transport は payload を JSON 文字列として渡してくることがある。
    // 文字列でも parse して field を届けることを assert（regression）。
    const dispatch = vi.fn();
    const handler = createSpaceEffectPlayHandler({
      effectDispatcher: { dispatch } as unknown as {
        dispatch: (r: SpaceEffectRequest) => unknown;
      },
    });
    await handler({
      kind: "abandoned-monitor",
      payload: JSON.stringify({ lines: ["a", "b"], durationMs: 6000 }),
    });
    expect(dispatch).toHaveBeenCalledWith({
      kind: "abandoned-monitor",
      lines: ["a", "b"],
      durationMs: 6000,
    });
  });

  it("dispatches with kind only when payload is an unparseable string", async () => {
    const dispatch = vi.fn();
    const handler = createSpaceEffectPlayHandler({
      effectDispatcher: { dispatch } as unknown as {
        dispatch: (r: SpaceEffectRequest) => unknown;
      },
    });
    await handler({ kind: "shake", payload: "not json {{" });
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

/** createUiSidebarSetHandler 既存テスト用 helper 型。presence ok 確定時の width 分岐。 */
type SidebarWidthResult = { readonly width?: number; readonly tweening?: boolean };

describe("createUiSidebarSetHandler", () => {
  const windowSize = { width: 1200, height: 800 };
  /** 既存テスト用: presence は常に解決可能とみなす ok stub。 */
  const precheckOk = () => ({ ok: true as const, el: {} as HTMLElement, target: "shell" as const });

  it("durationMs > 0 で tween 登録 + tweening: true", async () => {
    const tm = new TweenManager();
    const handler = createUiSidebarSetHandler({
      setSidebarWidth: () => {},
      getSidebarWidth: () => 280,
      getDefaultSidebarWidth: () => 280,
      getWindowSize: () => windowSize,
      tweenManager: tm,
      precheckPresence: precheckOk,
    });
    const result = (await handler({ width: 350, durationMs: 800 })) as SidebarWidthResult;
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
      precheckPresence: precheckOk,
    });
    const result = (await handler({ width: 350 })) as SidebarWidthResult;
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
      precheckPresence: precheckOk,
    });
    const result = (await handler({ width: 0 })) as SidebarWidthResult;
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
      precheckPresence: precheckOk,
    });
    const result = (await handler({ widthPercent: 50 })) as SidebarWidthResult;
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
      precheckPresence: precheckOk,
    });
    const result = (await handler({ width: 400, widthPercent: 80 })) as SidebarWidthResult;
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
      precheckPresence: precheckOk,
    });
    const result = (await handler({})) as SidebarWidthResult;
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
  const makeHandler = (registry: ScenePackRegistryImpl) =>
    createSceneActivateHandler({
      setActiveScene: (id) => registry.setActiveScene(id),
      getActiveSceneId: () => registry.getActiveSceneId(),
    });
  const makeProjectAwareHandler = (
    initialConfig: YorishiroConfig,
    projectRoot: string | null,
  ): {
    readonly handler: ReturnType<typeof createSceneActivateHandler>;
    readonly registry: ScenePackRegistryImpl;
    readonly getConfig: () => YorishiroConfig;
  } => {
    const registry = makeRegistry();
    let config = initialConfig;
    const handler = createSceneActivateHandler({
      setActiveScene: async (id) => {
        const updated = applyCurrentProjectSceneSelection(config, projectRoot, id);
        config = updated.config;
        registry.setActiveScene(updated.activeScene);
      },
      getActiveSceneId: () => registry.getActiveSceneId(),
    });
    return { handler, registry, getConfig: () => config };
  };

  it("switches active scene by id", async () => {
    const registry = makeRegistry();
    const handler = makeHandler(registry);
    const result = await handler({ id: "s2" });
    expect(result).toEqual({ active: "s2" });
    expect(registry.getActiveSceneId()).toBe("s2");
  });

  it("clears project override and falls back to global activeScene when id is null", async () => {
    const { handler, registry, getConfig } = makeProjectAwareHandler(
      {
        ...EMPTY_CONFIG,
        activeScene: "s2",
        sceneByProject: { "/repo/a": "s1" },
      },
      "/repo/a",
    );
    registry.setActiveScene("s1");

    const result = await handler({ id: null });

    expect(result.active).toBe("s2");
    expect(registry.getActiveSceneId()).toBe("s2");
    expect(getConfig()).toMatchObject({
      activeScene: "s2",
      sceneByProject: {},
    });
  });

  it("clears project override and falls back to bundled default when id is null and no global scene is set", async () => {
    const { handler, registry, getConfig } = makeProjectAwareHandler(
      {
        ...EMPTY_CONFIG,
        activeScene: null,
        sceneByProject: { "/repo/a": "s2" },
      },
      "/repo/a",
    );
    registry.setActiveScene("s2");

    const result = await handler({ id: null });

    expect(result.active).toBe("s1");
    expect(registry.getActiveSceneId()).toBe("s1");
    expect(getConfig()).toMatchObject({
      activeScene: null,
      sceneByProject: {},
    });
  });

  it("rejects empty string id", async () => {
    const registry = makeRegistry();
    const handler = makeHandler(registry);
    await expect(handler({ id: "" })).rejects.toThrow("id must be non-empty string or null");
  });

  it("rejects non-string non-null id", async () => {
    const registry = makeRegistry();
    const handler = makeHandler(registry);
    await expect(handler({ id: 42 })).rejects.toThrow("id must be non-empty string or null");
  });

  it("rejects when id field is omitted", async () => {
    const registry = makeRegistry();
    const handler = makeHandler(registry);
    await expect(handler({})).rejects.toThrow("id must be non-empty string or null");
  });

  it("setting unknown id falls through to bundled fallback (no throw)", async () => {
    const registry = makeRegistry();
    const handler = makeHandler(registry);
    // SingleActiveRegistry.setActive で unknown id は fall-through、bundled alphabetical 先頭が active
    const result = await handler({ id: "ghost" });
    expect(result.active).toBe("s1");
  });

  it("awaits the configured scene write path before reading active id", async () => {
    let active: string | null = "s1";
    const handler = createSceneActivateHandler({
      setActiveScene: async (id) => {
        await Promise.resolve();
        active = id;
      },
      getActiveSceneId: () => active,
    });

    const result = await handler({ id: "s2" });

    expect(result.active).toBe("s2");
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

describe("createPersonaGoodbyeSwitchHandler", () => {
  it("reloads a newly created persona if needed, writes primaryPersona behind the curtain, then reports reloading", async () => {
    let config: YorishiroConfig = { ...EMPTY_CONFIG, primaryPersona: "old" };
    let personaIds: string[] = ["old"];
    const calls: string[] = [];

    const handler = createPersonaGoodbyeSwitchHandler({
      updateConfig: async (update) => {
        calls.push("update-config");
        config = update(config);
      },
      beginCurtainReload: async (prepareReload) => {
        calls.push("curtain");
        await prepareReload?.();
      },
      markMainSessionRespawnPending: () => {
        calls.push("mark-main-respawn");
      },
      listPersonaIds: () => personaIds,
      reloadPack: async (id) => {
        calls.push(`reload:${id}`);
        personaIds = [...personaIds, id];
        return { ok: true };
      },
      waitForFarewell: async () => {
        calls.push("wait-farewell");
      },
      recordFarewell: async (toPersonaId) => {
        calls.push(`record-farewell:${toPersonaId}`);
      },
      stageVrmPath: async (path) => {
        calls.push(`stage-vrm:${path}`);
      },
    });

    const result = await handler({ id: "new-persona" });

    expect(result).toEqual({ active: "new-persona", reloading: true });
    expect(config.primaryPersona).toBe("new-persona");
    // お別れの声を言い終わるのを待ってから暗転。記録は config 更新前
    // （active がまだ去る側のうち）に書く。vrmPath 無しなら VRM は触らない。
    expect(calls).toEqual([
      "reload:new-persona",
      "wait-farewell",
      "curtain",
      "record-farewell:new-persona",
      "update-config",
      "mark-main-respawn",
    ]);
  });

  it("vrmPath が渡されたら暗転中に次回 boot の VRM を差し替える", async () => {
    const calls: string[] = [];
    const handler = createPersonaGoodbyeSwitchHandler({
      updateConfig: async () => {
        calls.push("update-config");
      },
      beginCurtainReload: async (prepareReload) => {
        calls.push("curtain");
        await prepareReload?.();
      },
      markMainSessionRespawnPending: () => {
        calls.push("mark-main-respawn");
      },
      listPersonaIds: () => ["next"],
      reloadPack: vi.fn(),
      waitForFarewell: vi.fn(async () => {}),
      recordFarewell: vi.fn(async () => {}),
      stageVrmPath: async (path) => {
        calls.push(`stage-vrm:${path}`);
      },
    });

    const result = await handler({ id: "next", vrmPath: "/tmp/new-avatar.vrm" });

    expect(result).toEqual({ active: "next", reloading: true });
    expect(calls).toEqual([
      "curtain",
      "stage-vrm:/tmp/new-avatar.vrm",
      "update-config",
      "mark-main-respawn",
    ]);
  });

  it("waitForFarewell が失敗しても切替は進む（演出は best-effort）", async () => {
    const beginCurtainReload = vi.fn(
      async (prepareReload?: () => void | Promise<void>) => await prepareReload?.(),
    );
    const handler = createPersonaGoodbyeSwitchHandler({
      updateConfig: vi.fn(async () => {}),
      beginCurtainReload,
      markMainSessionRespawnPending: vi.fn(),
      listPersonaIds: () => ["next"],
      reloadPack: vi.fn(),
      waitForFarewell: async () => {
        throw new Error("voice tracking broke");
      },
      recordFarewell: vi.fn(async () => {}),
      stageVrmPath: vi.fn(),
    });

    const result = await handler({ id: "next" });

    expect(result).toEqual({ active: "next", reloading: true });
    expect(beginCurtainReload).toHaveBeenCalled();
  });

  it("recordFarewell が失敗しても切替は進み、config は更新される", async () => {
    let config: YorishiroConfig = { ...EMPTY_CONFIG, primaryPersona: "old" };
    const handler = createPersonaGoodbyeSwitchHandler({
      updateConfig: async (update) => {
        config = update(config);
      },
      beginCurtainReload: async (prepareReload) => {
        await prepareReload?.();
      },
      markMainSessionRespawnPending: vi.fn(),
      listPersonaIds: () => ["next"],
      reloadPack: vi.fn(),
      waitForFarewell: vi.fn(async () => {}),
      recordFarewell: async () => {
        throw new Error("memories.md write failed");
      },
      stageVrmPath: vi.fn(),
    });

    const result = await handler({ id: "next" });

    expect(result).toEqual({ active: "next", reloading: true });
    expect(config.primaryPersona).toBe("next");
  });

  it("rejects when the target persona cannot be loaded", async () => {
    const handler = createPersonaGoodbyeSwitchHandler({
      updateConfig: vi.fn(),
      beginCurtainReload: vi.fn(),
      markMainSessionRespawnPending: vi.fn(),
      listPersonaIds: () => ["old"],
      reloadPack: async () => ({ ok: false, reason: "pack file not found" }),
      waitForFarewell: vi.fn(async () => {}),
      recordFarewell: vi.fn(async () => {}),
      stageVrmPath: vi.fn(),
    });

    await expect(handler({ id: "missing" })).rejects.toThrow(
      "persona 'missing' is not loadable: pack file not found",
    );
  });

  it("rejects empty id", async () => {
    const handler = createPersonaGoodbyeSwitchHandler({
      updateConfig: vi.fn(),
      beginCurtainReload: vi.fn(),
      markMainSessionRespawnPending: vi.fn(),
      listPersonaIds: () => [],
      reloadPack: vi.fn(),
      waitForFarewell: vi.fn(async () => {}),
      recordFarewell: vi.fn(async () => {}),
      stageVrmPath: vi.fn(),
    });

    await expect(handler({ id: "" })).rejects.toThrow("id must be a non-empty string");
  });
});

describe("createPresenceSetIntensityHandler", () => {
  it("valid level を受け付ける", async () => {
    const apply = vi.fn().mockReturnValue({ applied: true });
    const handler = createPresenceSetIntensityHandler({ applyPresenceLevel: apply });
    const result = await handler({ level: "closed" });
    expect((result as { level: string }).level).toBe("closed");
    expect(apply).toHaveBeenCalledWith("closed", "mcp");
  });

  it("invalid level で throw する", async () => {
    const apply = vi.fn().mockReturnValue({ applied: true });
    const handler = createPresenceSetIntensityHandler({ applyPresenceLevel: apply });
    await expect(handler({ level: "invalid" })).rejects.toThrow("invalid presence level");
  });

  // loud-unavailable: presence 解決不能時、presence.set-intensity は typed unavailable を返す（spec §4）。
  it("applyPresenceLevel が unavailable を返すと typed unavailable を返す", async () => {
    const handler = createPresenceSetIntensityHandler({
      applyPresenceLevel: () => ({ unavailable: true, reason: "no presence target" }),
    });
    const r = await handler({ level: "closed" });
    expect(r).toEqual({ unavailable: true, reason: "no presence target" });
  });

  it("applyPresenceLevel が applied:true を返すと { level } を返す", async () => {
    const handler = createPresenceSetIntensityHandler({
      applyPresenceLevel: () => ({ applied: true }),
    });
    const r = await handler({ level: "closed" });
    expect(r).toEqual({ level: "closed" });
  });
});

describe("createSetMotionIntensityHandler", () => {
  it("writes clamped intensity to config and applies to runtime", async () => {
    const updateConfig = vi.fn(async (update: (current: YorishiroConfig) => YorishiroConfig) =>
      update({ ...EMPTY_CONFIG }),
    );
    const applyToRuntime = vi.fn();
    const handler = createSetMotionIntensityHandler({
      updateConfig,
      applyToRuntime,
    });
    const result = await handler({ intensity: 9 });
    expect(result).toEqual({ intensity: 3 });
    expect(updateConfig).toHaveBeenCalledOnce();
    expect(updateConfig.mock.calls[0][0]({ ...EMPTY_CONFIG })).toEqual({
      ...EMPTY_CONFIG,
      motionIntensity: 3,
    });
    expect(applyToRuntime).toHaveBeenCalledWith(3);
  });

  it("rejects non-numeric intensity", async () => {
    const handler = createSetMotionIntensityHandler({
      updateConfig: async (update) => update({ ...EMPTY_CONFIG }),
      applyToRuntime: () => {},
    });
    await expect(handler({ intensity: "big" })).rejects.toThrow();
  });

  it("composes concurrent config updates through the injected atomic updater", async () => {
    let config: YorishiroConfig = { ...EMPTY_CONFIG };
    let chain = Promise.resolve();
    const updateConfig = (update: (current: YorishiroConfig) => YorishiroConfig) => {
      const next = chain.then(async () => {
        config = update(config);
        return config;
      });
      chain = next.then(() => undefined);
      return next;
    };
    const registry = new UserPackRegistry();
    const disable = createDisablePackHandler({ updateConfig, registry });
    const motion = createSetMotionIntensityHandler({
      updateConfig,
      applyToRuntime: () => {},
    });

    await Promise.all([disable({ id: "target" }), motion({ intensity: 2 })]);

    expect(config.disabledPacks).toEqual(["target"]);
    expect(config.motionIntensity).toBe(2);
  });
});

describe("createVoiceSayHandler", () => {
  it("valid mood と intensity を speak へ透過する", async () => {
    const speak = vi.fn();
    const handler = createVoiceSayHandler({ speak, getFrequency: () => "on" });

    await handler({ text: "hello", voice: "Kyoko", mood: "happy", moodIntensity: 0.4 });

    expect(speak).toHaveBeenCalledWith("hello", "Kyoko", {
      preset: "happy",
      intensity: 0.4,
    });
  });

  it.each(["happy", "sad", "angry", "relaxed", "surprised"])("mood=%s を受理する", async (mood) => {
    const speak = vi.fn();
    const handler = createVoiceSayHandler({ speak, getFrequency: () => "on" });

    await handler({ text: "hello", mood });

    expect(speak).toHaveBeenCalledWith("hello", undefined, { preset: mood, intensity: 1 });
  });

  it("invalid mood は無視して発話を続ける", async () => {
    const speak = vi.fn();
    const handler = createVoiceSayHandler({ speak, getFrequency: () => "on" });

    await expect(handler({ text: "hello", mood: "excited", moodIntensity: 0.5 })).resolves.toEqual({
      spoken: true,
    });
    expect(speak).toHaveBeenCalledWith("hello", undefined, undefined);
  });

  it.each([
    [-1, 0],
    [2, 1],
  ])("moodIntensity=%s を %s にクランプする", async (input, expected) => {
    const speak = vi.fn();
    const handler = createVoiceSayHandler({ speak, getFrequency: () => "on" });

    await handler({ text: "hello", mood: "sad", moodIntensity: input });

    expect(speak).toHaveBeenCalledWith("hello", undefined, {
      preset: "sad",
      intensity: expected,
    });
  });

  it("moodIntensity が number でなければ既定値 1 を使う", async () => {
    const speak = vi.fn();
    const handler = createVoiceSayHandler({ speak, getFrequency: () => "on" });

    await handler({ text: "hello", mood: "relaxed", moodIntensity: "strong" });

    expect(speak).toHaveBeenCalledWith("hello", undefined, {
      preset: "relaxed",
      intensity: 1,
    });
  });
});

/* ──────────────────────────────────────────────────────────
 * createUiSidebarSetHandler — loud-unavailable
 * ────────────────────────────────────────────────────────── */

describe("createUiSidebarSetHandler loud-unavailable", () => {
  // loud-unavailable: presence 解決不能時、ui.sidebar.set は width を書かず
  // { unavailable:true, reason } を返す（spec §4、silent no-op にしない）。
  it("precheckPresence が ok:false のとき typed unavailable を返し setSidebarWidth を呼ばない", async () => {
    const tm = new TweenManager();
    let setCalls = 0;
    const handler = createUiSidebarSetHandler({
      setSidebarWidth: () => {
        setCalls++;
      },
      getSidebarWidth: () => 280,
      getDefaultSidebarWidth: () => 280,
      getWindowSize: () => ({ width: 1000, height: 800 }),
      tweenManager: tm,
      precheckPresence: () => ({ ok: false, reason: "no presence target" }),
    });
    const r = await handler({ width: 0 });
    expect(r).toEqual({ unavailable: true, reason: "no presence target" });
    expect(setCalls).toBe(0);
  });

  it("precheckPresence が ok:true なら従来通り width を返す", async () => {
    const tm = new TweenManager();
    const handler = createUiSidebarSetHandler({
      setSidebarWidth: () => {},
      getSidebarWidth: () => 280,
      getDefaultSidebarWidth: () => 280,
      getWindowSize: () => ({ width: 1000, height: 800 }),
      tweenManager: tm,
      precheckPresence: () => ({ ok: true, el: {} as HTMLElement, target: "shell" as const }),
    });
    const r = await handler({ width: 123 });
    expect(r).toEqual({ width: 123 });
  });
});

describe("createBundledExampleReadHandler", () => {
  const mockResponse: BundledExampleResponse = {
    id: "screen-shake",
    kind: "effect",
    files: [
      { path: "effect.ts", content: 'export default { id: "screen-shake" };' },
      { path: "manifest.json", content: '{ "id": "screen-shake", "type": "effect" }' },
      { path: "lib/utils.tsx", content: "export function shake() {}" },
    ],
  };

  it("正常系: bundled pack のソースを markdown 形式で返す", async () => {
    const handler = createBundledExampleReadHandler({
      readBundledPackSource: async (id) => {
        expect(id).toBe("screen-shake");
        return mockResponse;
      },
    });

    const result = await handler({ id: "screen-shake" });
    expect(result).toContain("# screen-shake (effect)");
    expect(result).toContain("## effect.ts");
    expect(result).toContain("```typescript");
    expect(result).toContain('export default { id: "screen-shake" };');
    expect(result).toContain("## manifest.json");
    expect(result).toContain("```json");
    expect(result).toContain("## lib/utils.tsx");
  });

  it("異常系: 存在しない id でエラーが返る", async () => {
    const handler = createBundledExampleReadHandler({
      readBundledPackSource: async () => {
        throw new Error("Pack 'ghost' not found. Available: [screen-shake, yori-ja]");
      },
    });

    await expect(handler({ id: "ghost" })).rejects.toThrow(
      "Pack 'ghost' not found. Available: [screen-shake, yori-ja]",
    );
  });

  it("異常系: id が空文字のとき throw する", async () => {
    const handler = createBundledExampleReadHandler({
      readBundledPackSource: vi.fn(),
    });

    await expect(handler({ id: "" })).rejects.toThrow("id must be a non-empty string");
  });

  it("異常系: id が省略されたとき throw する", async () => {
    const handler = createBundledExampleReadHandler({
      readBundledPackSource: vi.fn(),
    });

    await expect(handler({})).rejects.toThrow("id must be a non-empty string");
  });
});

describe("createAttentionLightCueHandler", () => {
  it("triggerManual が triggered:true を返す場合、そのまま返す", async () => {
    const trigger = vi.fn<() => ManualCueResult>().mockReturnValue({ triggered: true });
    const handler = createAttentionLightCueHandler({ trigger });
    const result = await handler({});
    expect(result).toEqual({ triggered: true });
    expect(trigger).toHaveBeenCalledOnce();
  });

  it("triggerManual が disabled を返す場合、error にせずそのまま返す", async () => {
    const trigger = vi.fn<() => ManualCueResult>().mockReturnValue({
      triggered: false,
      reason: "disabled",
    });
    const handler = createAttentionLightCueHandler({ trigger });
    const result = await handler({});
    expect(result).toEqual({ triggered: false, reason: "disabled" });
  });

  it("triggerManual が cooldown を返す場合、error にせずそのまま返す", async () => {
    const trigger = vi.fn<() => ManualCueResult>().mockReturnValue({
      triggered: false,
      reason: "cooldown",
    });
    const handler = createAttentionLightCueHandler({ trigger });
    const result = await handler({});
    expect(result).toEqual({ triggered: false, reason: "cooldown" });
  });
});

describe("createPersonaReflexListHandler", () => {
  const noop = async () => {};

  const yoriReflex: NonNullable<PersonaDefinition["reflex"]> = {
    customTriggers: [
      {
        id: "yori:git-push-success",
        description: "git push 成功で celebrate を発火",
        match: () => null,
      },
      // description 未宣言の trigger
      { id: "yori:error", match: () => null },
    ],
    responses: {
      celebrate: { handlers: [{ label: "fireworks-and-smile", handler: noop }] },
      "idle-fidget": {
        handlers: [
          { weight: 3, label: "look-around", handler: noop },
          { weight: 1, cooldownMs: 180000, label: "subtle-stretch", handler: noop },
        ],
      },
    },
  };

  const yoriEntry = {
    id: "yori",
    origin: "bundled" as const,
    persona: { id: "yori", name: "Yori", reflex: yoriReflex } as PersonaDefinition,
  };

  const makeHandler = (
    overrides: Partial<Parameters<typeof createPersonaReflexListHandler>[0]> = {},
  ) =>
    createPersonaReflexListHandler({
      listPersonaEntries: () => [yoriEntry],
      getActivePersonaId: () => "yori",
      getDefaultReflex: () => yoriReflex,
      ...overrides,
    });

  it("personaId 省略時は active persona の trigger / response 一覧を返す", async () => {
    const result = await makeHandler()({});
    expect(result.personaId).toBe("yori");
    expect(result.origin).toBe("bundled");
    expect(result.triggers).toEqual([
      { id: "yori:git-push-success", description: "git push 成功で celebrate を発火" },
      { id: "yori:error", description: null },
    ]);
    expect(result.responses).toEqual({
      celebrate: [{ label: "fireworks-and-smile", weight: 1, cooldownMs: null }],
      "idle-fidget": [
        { label: "look-around", weight: 3, cooldownMs: null },
        { label: "subtle-stretch", weight: 1, cooldownMs: 180000 },
      ],
    });
  });

  it("bundled persona は default reflex と同一 reference でも own と報告する", async () => {
    const result = await makeHandler()({});
    expect(result.reflexSource).toBe("own");
  });

  it("reflex を持たない user persona（loader が default を merge 済み）は inherited-default", async () => {
    const minimal = {
      id: "minimal",
      origin: "user" as const,
      // loader の applyPersonaDefaults 相当：bundled default の reflex を共有
      persona: { id: "minimal", name: "最小住人", reflex: yoriReflex } as PersonaDefinition,
    };
    const result = await makeHandler({
      listPersonaEntries: () => [yoriEntry, minimal],
    })({ personaId: "minimal" });
    expect(result.reflexSource).toBe("inherited-default");
    // 継承の場合も「実際に発火するもの」として default の中身を列挙する
    expect(result.triggers).toHaveLength(2);
  });

  it("独自 reflex を持つ user persona は own", async () => {
    const custom = {
      id: "custom",
      origin: "user" as const,
      persona: {
        id: "custom",
        name: "独自",
        reflex: { responses: { pleased: { handlers: [{ handler: noop }] } } },
      } as PersonaDefinition,
    };
    const result = await makeHandler({
      listPersonaEntries: () => [yoriEntry, custom],
    })({ personaId: "custom" });
    expect(result.reflexSource).toBe("own");
    expect(result.responses).toEqual({
      pleased: [{ label: null, weight: 1, cooldownMs: null }],
    });
  });

  it("reflex が無い（fallback も無効な）persona は none で空一覧", async () => {
    const bare = {
      id: "bare",
      origin: "user" as const,
      persona: { id: "bare", name: "素" } as PersonaDefinition,
    };
    const result = await makeHandler({
      listPersonaEntries: () => [yoriEntry, bare],
    })({ personaId: "bare" });
    expect(result.reflexSource).toBe("none");
    expect(result.triggers).toEqual([]);
    expect(result.responses).toEqual({});
  });

  it("未登録の personaId は既知 id 一覧つきで throw する", async () => {
    await expect(makeHandler()({ personaId: "ghost" })).rejects.toThrow(/known: yori/);
  });

  it("active も personaId も無ければ throw する", async () => {
    await expect(makeHandler({ getActivePersonaId: () => null })({})).rejects.toThrow(
      /no active persona/,
    );
  });
});

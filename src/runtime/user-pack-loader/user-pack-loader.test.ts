/**
 * Tests for loadUserPacks — Phase 1-a の static user pack load。
 *
 * effectPackRunner / personaRegistry は構造的 interface に narrow してあるので、
 * ここでは real instance を組まずに stub で直接検証する。
 */

import type { EffectDefinition, PersonaDefinition } from "@charminal/sdk";
import { describe, expect, it, vi } from "vitest";
import { createSubsystemLog, DevLog, type SubsystemLog } from "../../core/dev-log";
import { Time } from "../../core/time";

// @tauri-apps/api/core は Tauri runtime なしでは動かないので stub する。
// scene branch が convertFileSrc で manifest URL を構築するため必要。
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
  invoke: vi.fn(),
  Channel: vi.fn(),
}));

import type { AmbientUiPackEntry, AmbientUiPackRegistry } from "../ambient-ui-pack-registry";
import type { PersonaEntry } from "../persona-registry";
import type { ScenePackEntry, ScenePackRegistry } from "../scene-pack-registry";
import type { UiPackEntry, UiPackRegistry } from "../ui-pack-registry";
import {
  type EffectRegistrar,
  loadSingleUserPack,
  loadUserPacks,
  type PersonaRegistrar,
  type UserPackEntry,
} from "./user-pack-loader";
import { UserPackRegistry } from "./user-pack-registry";

// ─── test fixtures ─────────────────────────────────────────────────

const validEffectPack: EffectDefinition = {
  id: "user-flash",
  type: "effect",
  run: async () => {},
};

const validPersonaPack = {
  id: "user-persona",
  name: "User Persona",
  thinking: { systemPromptAddition: "" },
  reflex: { responses: {} },
  world: { body: "", voice: "", space: "" },
  logReading: { readWhen: { kind: "never" }, framing: "absent", windowSize: 0 },
} as unknown as PersonaDefinition;

const validUiPack = {
  id: "user-ui",
  type: "ui",
  layout: {},
  mount: () => ({ dispose: () => {} }),
};

const validAmbientUiPack = {
  id: "user-ambient",
  type: "ambient-ui",
  mount: () => ({ dispose: () => {} }),
};

// ─── fakes ────────────────────────────────────────────────────────

interface EffectRegistrarFake extends EffectRegistrar {
  readonly registered: EffectDefinition[];
  readonly disposedIds: string[];
}

const makeEffectRegistrar = (): EffectRegistrarFake => {
  const registered: EffectDefinition[] = [];
  const disposedIds: string[] = [];
  return {
    registered,
    disposedIds,
    register(pack) {
      registered.push(pack);
      return {
        dispose: () => {
          disposedIds.push(pack.id);
        },
      };
    },
  };
};

interface PersonaRegistrarFake extends PersonaRegistrar {
  readonly registered: PersonaEntry[];
  readonly disposedIds: string[];
}

const makePersonaRegistrar = (
  opts: { rejectIds?: ReadonlySet<string> } = {},
): PersonaRegistrarFake => {
  const registered: PersonaEntry[] = [];
  const disposedIds: string[] = [];
  return {
    registered,
    disposedIds,
    register(entry) {
      if (opts.rejectIds?.has(entry.id)) {
        throw new Error(`PersonaRegistry: packId already registered: ${entry.id}`);
      }
      registered.push(entry);
      return {
        dispose: () => {
          disposedIds.push(entry.id);
        },
      };
    },
  };
};

interface DevLogFixture {
  readonly log: DevLog;
  readonly subsystem: SubsystemLog;
}

const makeDevLog = (): DevLogFixture => {
  const log = new DevLog({ time: new Time() });
  return { log, subsystem: createSubsystemLog(log, "UserPackLoader") };
};

function makeFakeScenePackRegistry(): ScenePackRegistry {
  const entries: ScenePackEntry[] = [];
  return {
    register: (e) => {
      entries.push(e);
      return { dispose: () => {} };
    },
    getActiveScene: () => null,
    subscribeActive: () => ({ dispose: () => {} }),
    setActiveScene: () => {},
    listEntries: () => entries,
  };
}

function makeFakeUiPackRegistry(): UiPackRegistry & { readonly entries: UiPackEntry[] } {
  const entries: UiPackEntry[] = [];
  return {
    entries,
    register: (entry) => {
      entries.push(entry);
      return { dispose: () => {} };
    },
    getActiveUi: () => null,
    setActiveUi: () => {},
    subscribeActive: () => ({ dispose: () => {} }),
    listEntries: () => entries,
  };
}

function makeFakeAmbientUiPackRegistry(): AmbientUiPackRegistry & {
  readonly entries: AmbientUiPackEntry[];
} {
  const entries: AmbientUiPackEntry[] = [];
  const activeSet: string[] = [];
  return {
    entries,
    register: (entry) => {
      entries.push(entry);
      return { dispose: () => {} };
    },
    listEntries: () => entries,
    enable: (id) => {
      if (!activeSet.includes(id)) activeSet.push(id);
    },
    disable: (id) => {
      const idx = activeSet.indexOf(id);
      if (idx !== -1) activeSet.splice(idx, 1);
    },
    getActiveSet: () => activeSet,
    subscribeActiveSet: () => ({ dispose: () => {} }),
  };
}

// ─── tests ────────────────────────────────────────────────────────

describe("loadUserPacks", () => {
  it("registers valid effect and persona packs", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { subsystem } = makeDevLog();
    const entries: UserPackEntry[] = [
      { id: "user-flash", kind: "effect", entryPath: "/p/user-flash/effect.js" },
      { id: "user-persona", kind: "persona", entryPath: "/p/user-persona/persona.js" },
    ];
    const modules = new Map<string, unknown>([
      [entries[0].entryPath, { default: validEffectPack }],
      [entries[1].entryPath, { default: validPersonaPack }],
    ]);

    const result = await loadUserPacks({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      scenePackRegistry: makeFakeScenePackRegistry(),
      ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
      devLog: subsystem,
      packRegistry: new UserPackRegistry(),
      fetchPackEntries: async () => entries,
      importModule: async (p) => modules.get(p),
    });

    expect(effectReg.registered).toEqual([validEffectPack]);
    expect(personaReg.registered).toHaveLength(1);
    expect(personaReg.registered[0].persona).toMatchObject(validPersonaPack);
    expect(personaReg.registered[0].origin).toBe("user");
    expect(result.loaded).toEqual([
      { id: "user-flash", kind: "effect" },
      { id: "user-persona", kind: "persona" },
    ]);
    expect(result.failed).toEqual([]);
  });

  it("records validator failures without aborting remaining packs", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { log, subsystem } = makeDevLog();
    const entries: UserPackEntry[] = [
      { id: "bad", kind: "effect", entryPath: "/p/bad.js" },
      { id: "good", kind: "effect", entryPath: "/p/good.js" },
    ];
    const modules = new Map<string, unknown>([
      ["/p/bad.js", { default: { id: "bad", type: "effect" /* run missing */ } }],
      ["/p/good.js", { default: validEffectPack }],
    ]);

    const result = await loadUserPacks({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      scenePackRegistry: makeFakeScenePackRegistry(),
      ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
      devLog: subsystem,
      packRegistry: new UserPackRegistry(),
      fetchPackEntries: async () => entries,
      importModule: async (p) => modules.get(p),
    });

    expect(effectReg.registered).toEqual([validEffectPack]);
    expect(result.loaded).toEqual([{ id: "good", kind: "effect" }]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ id: "bad", kind: "effect" });
    expect(result.failed[0].error).toMatch(/run/);
    expect(log.read().some((e) => e.phase === "validate")).toBe(true);
  });

  it("records import failures without aborting remaining packs", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { subsystem } = makeDevLog();
    const entries: UserPackEntry[] = [
      { id: "broken", kind: "effect", entryPath: "/p/broken.js" },
      { id: "good", kind: "effect", entryPath: "/p/good.js" },
    ];

    const result = await loadUserPacks({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      scenePackRegistry: makeFakeScenePackRegistry(),
      ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
      devLog: subsystem,
      packRegistry: new UserPackRegistry(),
      fetchPackEntries: async () => entries,
      importModule: async (p) => {
        if (p === "/p/broken.js") throw new Error("boom");
        return { default: validEffectPack };
      },
    });

    expect(effectReg.registered).toEqual([validEffectPack]);
    expect(result.loaded).toEqual([{ id: "good", kind: "effect" }]);
    expect(result.failed).toEqual([{ id: "broken", kind: "effect", error: "boom" }]);
  });

  it("skips unsupported kinds and warns into the dev log", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { log, subsystem } = makeDevLog();
    // "voice" は現在 SUPPORTED_PACK_KINDS に含まれない kind
    const entries: UserPackEntry[] = [{ id: "my-voice", kind: "voice", entryPath: "/p/voice.js" }];

    const result = await loadUserPacks({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      scenePackRegistry: makeFakeScenePackRegistry(),
      ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
      devLog: subsystem,
      packRegistry: new UserPackRegistry(),
      fetchPackEntries: async () => entries,
      importModule: async () => ({ default: {} }),
    });

    expect(result.loaded).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(log.read().some((e) => (e.note ?? "").includes("voice"))).toBe(true);
  });

  it("loads scene pack via scenePackRegistry", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const fakeScenes: ScenePackEntry[] = [];
    const fakeScenePackRegistry: ScenePackRegistry = {
      register: (e) => {
        fakeScenes.push(e);
        return { dispose: () => {} };
      },
      getActiveScene: () => null,
      subscribeActive: () => ({ dispose: () => {} }),
      setActiveScene: () => {},
      listEntries: () => fakeScenes,
    };
    const { log, subsystem } = makeDevLog();
    const entries: UserPackEntry[] = [
      { id: "my-scene", kind: "scene", entryPath: "/p/my-scene/scene.js" },
    ];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "my-scene",
          type: "scene",
          version: "0.1.0",
          charminalVersion: "^0.1.0",
          entry: "scene.js",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    try {
      const result = await loadUserPacks({
        effectPackRunner: effectReg,
        personaRegistry: personaReg,
        scenePackRegistry: fakeScenePackRegistry,
        ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
        packRegistry: new UserPackRegistry(),
        devLog: subsystem,
        fetchPackEntries: async () => entries,
        importModule: async () => ({
          default: {
            id: "my-scene",
            type: "scene",
            scene: { id: "my-scene", layers: [{ id: "bg", role: "background" }] },
          },
        }),
      });

      expect(result.loaded).toEqual([{ id: "my-scene", kind: "scene" }]);
      expect(result.failed).toEqual([]);
      expect(fakeScenes).toHaveLength(1);
      expect(fakeScenes[0].origin).toBe("user");
      expect(log.read().some((e) => (e.note ?? "").includes("registered scene"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("loads ui pack via uiPackRegistry", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const uiRegistry = makeFakeUiPackRegistry();
    const { subsystem } = makeDevLog();
    const entries: UserPackEntry[] = [
      { id: "user-ui", kind: "ui", entryPath: "/p/user-ui/ui.tsx" },
    ];

    const result = await loadUserPacks({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      scenePackRegistry: makeFakeScenePackRegistry(),
      uiPackRegistry: uiRegistry,
      ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
      devLog: subsystem,
      packRegistry: new UserPackRegistry(),
      fetchPackEntries: async () => entries,
      importModule: async () => ({ default: validUiPack }),
    });

    expect(result.loaded).toEqual([{ id: "user-ui", kind: "ui" }]);
    expect(result.failed).toEqual([]);
    expect(uiRegistry.entries).toHaveLength(1);
    expect(uiRegistry.entries[0]).toMatchObject({
      id: "user-ui",
      origin: "user",
      manifest: { id: "user-ui", type: "ui", entry: "ui.tsx" },
    });
  });

  it("registers an ambient-ui pack into ambientUiPackRegistry", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const uiRegistry = makeFakeUiPackRegistry();
    const ambientUiRegistry = makeFakeAmbientUiPackRegistry();
    const { subsystem } = makeDevLog();
    const entries: UserPackEntry[] = [
      { id: "user-ambient", kind: "ambient-ui", entryPath: "/p/user-ambient/ui.js" },
    ];

    const result = await loadUserPacks({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      scenePackRegistry: makeFakeScenePackRegistry(),
      uiPackRegistry: uiRegistry,
      ambientUiPackRegistry: ambientUiRegistry,
      devLog: subsystem,
      packRegistry: new UserPackRegistry(),
      fetchPackEntries: async () => entries,
      importModule: async () => ({ default: validAmbientUiPack }),
    });

    expect(result.loaded).toEqual([{ id: "user-ambient", kind: "ambient-ui" }]);
    expect(result.failed).toEqual([]);
    expect(ambientUiRegistry.entries).toHaveLength(1);
    expect(ambientUiRegistry.entries[0]).toMatchObject({
      id: "user-ambient",
      origin: "user",
      manifest: { id: "user-ambient", type: "ambient-ui", entry: "ui.js" },
    });
  });

  it("does not register an ambient-ui pack into uiPackRegistry (no double-register)", async () => {
    // v1 critical（全 user UI pack が attention UI registry に二重登録される）の不在を assert する。
    // ambient-ui kind は ambientUiPackRegistry のみ、uiPackRegistry は 0 件のまま。
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const uiRegistry = makeFakeUiPackRegistry();
    const ambientUiRegistry = makeFakeAmbientUiPackRegistry();
    const { subsystem } = makeDevLog();
    const entries: UserPackEntry[] = [
      { id: "user-ambient", kind: "ambient-ui", entryPath: "/p/user-ambient/ui.js" },
    ];

    await loadUserPacks({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      scenePackRegistry: makeFakeScenePackRegistry(),
      uiPackRegistry: uiRegistry,
      ambientUiPackRegistry: ambientUiRegistry,
      devLog: subsystem,
      packRegistry: new UserPackRegistry(),
      fetchPackEntries: async () => entries,
      importModule: async () => ({ default: validAmbientUiPack }),
    });

    // uiPackRegistry には一切触れていないことを確認（v1 二重登録の不在）
    expect(uiRegistry.entries).toHaveLength(0);
    // ambientUiPackRegistry には正しく 1 件登録されている
    expect(ambientUiRegistry.entries).toHaveLength(1);
    expect(ambientUiRegistry.entries[0].id).toBe("user-ambient");
  });

  it("scene pack fails if default export type is not 'scene'", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { subsystem } = makeDevLog();
    const entries: UserPackEntry[] = [
      { id: "bad-scene", kind: "scene", entryPath: "/p/bad-scene/scene.js" },
    ];

    const result = await loadUserPacks({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      scenePackRegistry: makeFakeScenePackRegistry(),
      ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
      packRegistry: new UserPackRegistry(),
      devLog: subsystem,
      fetchPackEntries: async () => entries,
      importModule: async () => ({
        default: { id: "bad-scene", type: "effect", scene: {} },
      }),
    });

    expect(result.loaded).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toMatch(/type must be "scene"/);
  });

  it("scene pack fails if manifest.json is 404", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { subsystem } = makeDevLog();
    const entries: UserPackEntry[] = [
      { id: "no-manifest", kind: "scene", entryPath: "/p/no-manifest/scene.js" },
    ];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;

    try {
      const result = await loadUserPacks({
        effectPackRunner: effectReg,
        personaRegistry: personaReg,
        scenePackRegistry: makeFakeScenePackRegistry(),
        ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
        packRegistry: new UserPackRegistry(),
        devLog: subsystem,
        fetchPackEntries: async () => entries,
        importModule: async () => ({
          default: {
            id: "no-manifest",
            type: "scene",
            scene: { id: "no-manifest", layers: [] },
          },
        }),
      });

      expect(result.loaded).toEqual([]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].error).toMatch(/manifest\.json not found/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("captures persona duplicate-id register throws as failed, not thrown", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar({ rejectIds: new Set(["dup"]) });
    const { subsystem } = makeDevLog();
    const dup = { ...validPersonaPack, id: "dup" } as unknown as PersonaDefinition;
    const entries: UserPackEntry[] = [{ id: "dup", kind: "persona", entryPath: "/p/dup.js" }];

    const result = await loadUserPacks({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      scenePackRegistry: makeFakeScenePackRegistry(),
      ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
      devLog: subsystem,
      packRegistry: new UserPackRegistry(),
      fetchPackEntries: async () => entries,
      importModule: async () => ({ default: dup }),
    });

    expect(personaReg.registered).toEqual([]);
    expect(result.loaded).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ id: "dup", kind: "persona" });
    expect(result.failed[0].error).toMatch(/already registered/);
  });

  it("returns empty result when fetchPackEntries throws", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { log, subsystem } = makeDevLog();

    const result = await loadUserPacks({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      scenePackRegistry: makeFakeScenePackRegistry(),
      ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
      devLog: subsystem,
      packRegistry: new UserPackRegistry(),
      fetchPackEntries: async () => {
        throw new Error("tauri invoke failed");
      },
      importModule: async () => ({}),
    });

    expect(result.loaded).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(log.read().some((e) => e.phase === "list" && (e.note ?? "").includes("failed"))).toBe(
      true,
    );
  });

  it("fails the entry when the module has no default export", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { subsystem } = makeDevLog();
    const entries: UserPackEntry[] = [
      { id: "nodefault", kind: "effect", entryPath: "/p/nodefault.js" },
    ];

    const result = await loadUserPacks({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      scenePackRegistry: makeFakeScenePackRegistry(),
      ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
      devLog: subsystem,
      packRegistry: new UserPackRegistry(),
      fetchPackEntries: async () => entries,
      importModule: async () => ({ /* no default */ notDefault: 1 }),
    });

    expect(effectReg.registered).toEqual([]);
    expect(result.loaded).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ id: "nodefault", kind: "effect" });
    expect(result.failed[0].error).toMatch(/default/i);
  });

  it("re-loading the same pack disposes the previous Disposable via packRegistry", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { subsystem } = makeDevLog();
    const registry = new UserPackRegistry();
    const entries: UserPackEntry[] = [{ id: "hot", kind: "effect", entryPath: "/p/hot.js" }];
    const firstPack: EffectDefinition = { id: "hot", type: "effect", run: async () => {} };
    const secondPack: EffectDefinition = { id: "hot", type: "effect", run: async () => {} };

    // First load: registers once, no disposal.
    await loadUserPacks({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      scenePackRegistry: makeFakeScenePackRegistry(),
      ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
      devLog: subsystem,
      packRegistry: registry,
      fetchPackEntries: async () => entries,
      importModule: async () => ({ default: firstPack }),
    });
    expect(effectReg.registered).toHaveLength(1);
    expect(effectReg.disposedIds).toEqual([]);

    // Second load: registry disposes prev before storing new.
    await loadUserPacks({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      scenePackRegistry: makeFakeScenePackRegistry(),
      ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
      devLog: subsystem,
      packRegistry: registry,
      fetchPackEntries: async () => entries,
      importModule: async () => ({ default: secondPack }),
    });
    expect(effectReg.registered).toHaveLength(2);
    expect(effectReg.disposedIds).toEqual(["hot"]);
  });

  it("filters out entries whose id is in disabledPacks", async () => {
    const effectPackRunner: EffectRegistrar = {
      register: () => ({ dispose: () => {} }),
    };
    const personaRegistry: PersonaRegistrar = {
      register: () => ({ dispose: () => {} }),
    };
    const packRegistry = new UserPackRegistry();
    const devLog = makeDevLog().subsystem;

    const result = await loadUserPacks({
      effectPackRunner,
      personaRegistry,
      scenePackRegistry: makeFakeScenePackRegistry(),
      ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
      packRegistry,
      devLog,
      disabledPacks: ["disabled-pack"],
      fetchPackEntries: async () => [
        {
          id: "enabled-pack",
          kind: "effect",
          entryPath: "/fake/enabled/effect.js",
        },
        {
          id: "disabled-pack",
          kind: "effect",
          entryPath: "/fake/disabled/effect.js",
        },
      ],
      importModule: async (path) => {
        if (path === "/fake/enabled/effect.js") {
          return {
            default: {
              id: "enabled-pack",
              type: "effect",
              run: async () => {},
            },
          };
        }
        throw new Error(`unexpected import: ${path}`);
      },
    });

    expect(result.loaded).toEqual([{ id: "enabled-pack", kind: "effect" }]);
    expect(result.failed).toEqual([]);
    expect(packRegistry.has("enabled-pack", "effect")).toBe(true);
    expect(packRegistry.has("disabled-pack", "effect")).toBe(false);
  });

  it("invokes writeLoadReport with the final load result", async () => {
    const captured: Array<{ timestamp: string; safeMode: boolean }> = [];
    const writeLoadReport = async (
      timestamp: string,
      safeMode: boolean,
      _report: unknown,
    ): Promise<void> => {
      captured.push({ timestamp, safeMode });
    };

    const effectPackRunner: EffectRegistrar = {
      register: () => ({ dispose: () => {} }),
    };
    const personaRegistry: PersonaRegistrar = {
      register: () => ({ dispose: () => {} }),
    };
    const packRegistry = new UserPackRegistry();
    const devLog = makeDevLog().subsystem;

    await loadUserPacks({
      effectPackRunner,
      personaRegistry,
      scenePackRegistry: makeFakeScenePackRegistry(),
      ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
      packRegistry,
      devLog,
      fetchPackEntries: async () => [],
      importModule: async () => ({ default: null }),
      writeLoadReport,
      timestamp: "2026-04-18T12:00:00.000Z",
      safeMode: false,
    });

    expect(captured).toEqual([{ timestamp: "2026-04-18T12:00:00.000Z", safeMode: false }]);
  });

  it("re-loading a persona uses packRegistry to sidestep duplicate-id throws", async () => {
    // pitfall #8: PersonaRegistry.register throws on duplicate id. The loader
    // must dispose the registry entry first so the real-world PersonaRegistry
    // sees the id as free.
    const effectReg = makeEffectRegistrar();
    // reject "dup" only after it has been registered once and then disposed —
    // simulate a registry that truly rejects duplicates by rejecting the second
    // raw register. The loader's dispose-first path should NOT trigger the
    // rejection because the fake's rejectIds only fires if called twice in
    // succession without dispose.
    const seen = new Set<string>();
    const personaReg: PersonaRegistrar & { registered: PersonaEntry[] } = {
      registered: [],
      register(entry) {
        if (seen.has(entry.id)) {
          throw new Error(`PersonaRegistry: packId already registered: ${entry.id}`);
        }
        seen.add(entry.id);
        personaReg.registered.push(entry);
        return {
          dispose: () => {
            seen.delete(entry.id);
          },
        };
      },
    };
    const { subsystem } = makeDevLog();
    const registry = new UserPackRegistry();
    const persona = { ...validPersonaPack, id: "dup" } as unknown as PersonaDefinition;
    const entries: UserPackEntry[] = [{ id: "dup", kind: "persona", entryPath: "/p/dup.js" }];

    await loadUserPacks({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      scenePackRegistry: makeFakeScenePackRegistry(),
      ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
      devLog: subsystem,
      packRegistry: registry,
      fetchPackEntries: async () => entries,
      importModule: async () => ({ default: persona }),
    });

    const result = await loadUserPacks({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      scenePackRegistry: makeFakeScenePackRegistry(),
      ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
      devLog: subsystem,
      packRegistry: registry,
      fetchPackEntries: async () => entries,
      importModule: async () => ({ default: persona }),
    });

    expect(personaReg.registered).toHaveLength(2);
    expect(result.loaded).toEqual([{ id: "dup", kind: "persona" }]);
    expect(result.failed).toEqual([]);
  });
});

describe("loadSingleUserPack", () => {
  const baseEntry = (overrides: Partial<UserPackEntry> = {}): UserPackEntry => ({
    id: "solo",
    kind: "effect",
    entryPath: "/fake/solo/effect.js",
    ...overrides,
  });

  it("registers an effect pack and returns loaded info", async () => {
    const runner: EffectRegistrar = {
      register: () => ({ dispose: () => {} }),
    };
    const persona: PersonaRegistrar = {
      register: () => ({ dispose: () => {} }),
    };
    const packRegistry = new UserPackRegistry();
    const devLog = makeDevLog().subsystem;

    const result = await loadSingleUserPack(baseEntry(), {
      effectPackRunner: runner,
      personaRegistry: persona,
      scenePackRegistry: makeFakeScenePackRegistry(),
      ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
      packRegistry,
      devLog,
      importModule: async () => ({
        default: { id: "solo", type: "effect", run: async () => {} },
      }),
    });

    expect(result.status).toBe("loaded");
    expect(packRegistry.has("solo", "effect")).toBe(true);
  });

  it("returns failed when importModule throws", async () => {
    const runner: EffectRegistrar = { register: () => ({ dispose: () => {} }) };
    const persona: PersonaRegistrar = { register: () => ({ dispose: () => {} }) };
    const packRegistry = new UserPackRegistry();
    const devLog = makeDevLog().subsystem;

    const result = await loadSingleUserPack(baseEntry(), {
      effectPackRunner: runner,
      personaRegistry: persona,
      scenePackRegistry: makeFakeScenePackRegistry(),
      ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
      packRegistry,
      devLog,
      importModule: async () => {
        throw new Error("network down");
      },
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("network down");
    }
  });

  it("returns failed for unsupported kind", async () => {
    const runner: EffectRegistrar = { register: () => ({ dispose: () => {} }) };
    const persona: PersonaRegistrar = { register: () => ({ dispose: () => {} }) };
    const packRegistry = new UserPackRegistry();
    const devLog = makeDevLog().subsystem;

    const result = await loadSingleUserPack(baseEntry({ kind: "unknown" }), {
      effectPackRunner: runner,
      personaRegistry: persona,
      scenePackRegistry: makeFakeScenePackRegistry(),
      ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
      packRegistry,
      devLog,
      importModule: async () => ({ default: {} }),
    });

    expect(result.status).toBe("failed");
  });

  it("replaces existing persona registration via dispose+register", async () => {
    const runner: EffectRegistrar = { register: () => ({ dispose: () => {} }) };
    let personaRegisterCount = 0;
    const persona: PersonaRegistrar = {
      register: () => {
        personaRegisterCount++;
        return { dispose: () => {} };
      },
    };
    const packRegistry = new UserPackRegistry();
    const devLog = makeDevLog().subsystem;

    const personaModule = {
      default: {
        id: "p",
        name: "P",
        thinking: { systemPromptAddition: "" },
        reflex: { responses: {} },
      },
    };

    // 1 回目
    await loadSingleUserPack(baseEntry({ id: "p", kind: "persona" }), {
      effectPackRunner: runner,
      personaRegistry: persona,
      scenePackRegistry: makeFakeScenePackRegistry(),
      ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
      packRegistry,
      devLog,
      importModule: async () => personaModule,
    });

    // 2 回目（disable→enable を模擬。persona は duplicate throw なので本来 failed だが
    // packRegistry.has → dispose 経路で救われるはず）
    const result = await loadSingleUserPack(baseEntry({ id: "p", kind: "persona" }), {
      effectPackRunner: runner,
      personaRegistry: persona,
      scenePackRegistry: makeFakeScenePackRegistry(),
      ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
      packRegistry,
      devLog,
      importModule: async () => personaModule,
    });

    expect(result.status).toBe("loaded");
    expect(personaRegisterCount).toBe(2);
    expect(packRegistry.has("p", "persona")).toBe(true);
  });

  // ─── persona.md inject テスト ─────────────────────────────────────

  it("injects persona.md when thinking is not set in persona.js", async () => {
    const runner: EffectRegistrar = { register: () => ({ dispose: () => {} }) };
    const registered: PersonaEntry[] = [];
    const persona: PersonaRegistrar = {
      register: (entry) => {
        registered.push(entry);
        return { dispose: () => {} };
      },
    };
    const packRegistry = new UserPackRegistry();
    const devLog = makeDevLog().subsystem;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("私はテスト住人。\n", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })) as typeof fetch;

    try {
      const result = await loadSingleUserPack(
        { id: "md-persona", kind: "persona", entryPath: "/fake/md-persona/persona.js" },
        {
          effectPackRunner: runner,
          personaRegistry: persona,
          scenePackRegistry: makeFakeScenePackRegistry(),
          ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
          packRegistry,
          devLog,
          importModule: async () => ({
            default: {
              id: "md-persona",
              name: "MD 住人",
              // thinking なし — loader が persona.md から inject する
              reflex: { responses: {} },
              world: { body: "", voice: "", space: "" },
              logReading: { readWhen: { kind: "never" }, framing: "absent", windowSize: 0 },
            },
          }),
        },
      );

      expect(result.status).toBe("loaded");
      expect(registered).toHaveLength(1);
      expect(registered[0].persona.thinking?.systemPromptAddition).toBe("私はテスト住人。");
      expect(registered[0].origin).toBe("user");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("prefers explicit thinking.systemPromptAddition in persona.js over persona.md", async () => {
    const runner: EffectRegistrar = { register: () => ({ dispose: () => {} }) };
    const registered: PersonaEntry[] = [];
    const persona: PersonaRegistrar = {
      register: (entry) => {
        registered.push(entry);
        return { dispose: () => {} };
      },
    };
    const packRegistry = new UserPackRegistry();
    const devLog = makeDevLog().subsystem;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("md の内容（無視される）", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })) as typeof fetch;

    try {
      const result = await loadSingleUserPack(
        { id: "explicit-persona", kind: "persona", entryPath: "/fake/explicit-persona/persona.js" },
        {
          effectPackRunner: runner,
          personaRegistry: persona,
          scenePackRegistry: makeFakeScenePackRegistry(),
          ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
          packRegistry,
          devLog,
          importModule: async () => ({
            default: {
              id: "explicit-persona",
              name: "明示住人",
              thinking: { systemPromptAddition: "js で明示したプロンプト" },
              reflex: { responses: {} },
              world: { body: "", voice: "", space: "" },
              logReading: { readWhen: { kind: "never" }, framing: "absent", windowSize: 0 },
            },
          }),
        },
      );

      expect(result.status).toBe("loaded");
      expect(registered[0].persona.thinking?.systemPromptAddition).toBe("js で明示したプロンプト");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("loads persona without md (404) when thinking is set in .js", async () => {
    const runner: EffectRegistrar = { register: () => ({ dispose: () => {} }) };
    const registered: PersonaEntry[] = [];
    const persona: PersonaRegistrar = {
      register: (entry) => {
        registered.push(entry);
        return { dispose: () => {} };
      },
    };
    const packRegistry = new UserPackRegistry();
    const devLog = makeDevLog().subsystem;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;

    try {
      const result = await loadSingleUserPack(
        { id: "no-md-persona", kind: "persona", entryPath: "/fake/no-md-persona/persona.js" },
        {
          effectPackRunner: runner,
          personaRegistry: persona,
          scenePackRegistry: makeFakeScenePackRegistry(),
          ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
          packRegistry,
          devLog,
          importModule: async () => ({
            default: {
              id: "no-md-persona",
              name: "MD 無し住人",
              thinking: { systemPromptAddition: "js 側のプロンプト" },
              reflex: { responses: {} },
              world: { body: "", voice: "", space: "" },
              logReading: { readWhen: { kind: "never" }, framing: "absent", windowSize: 0 },
            },
          }),
        },
      );

      expect(result.status).toBe("loaded");
      // 404 は no-op、.js の thinking がそのまま使われる
      expect(registered[0].persona.thinking?.systemPromptAddition).toBe("js 側のプロンプト");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("loads persona with neither thinking in .js nor persona.md", async () => {
    const runner: EffectRegistrar = { register: () => ({ dispose: () => {} }) };
    const registered: PersonaEntry[] = [];
    const persona: PersonaRegistrar = {
      register: (entry) => {
        registered.push(entry);
        return { dispose: () => {} };
      },
    };
    const packRegistry = new UserPackRegistry();
    const devLog = makeDevLog().subsystem;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;

    try {
      const result = await loadSingleUserPack(
        {
          id: "bare-persona",
          kind: "persona",
          entryPath: "/fake/bare-persona/persona.js",
        },
        {
          effectPackRunner: runner,
          personaRegistry: persona,
          scenePackRegistry: makeFakeScenePackRegistry(),
          ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
          packRegistry,
          devLog,
          importModule: async () => ({
            default: {
              id: "bare-persona",
              name: "素の住人",
              // thinking なし、md も 404 → systemPromptAddition は undefined のまま
              reflex: { responses: {} },
              world: { body: "", voice: "", space: "" },
              logReading: { readWhen: { kind: "never" }, framing: "absent", windowSize: 0 },
            },
          }),
        },
      );

      // load 自体は成功する（prompt 無しは valid な state）
      expect(result.status).toBe("loaded");
      expect(registered).toHaveLength(1);
      expect(registered[0].persona.thinking?.systemPromptAddition).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fills missing persona axes from bundled defaults for minimal persona packs", async () => {
    const runner: EffectRegistrar = { register: () => ({ dispose: () => {} }) };
    const registered: PersonaEntry[] = [];
    const persona: PersonaRegistrar = {
      register: (entry) => {
        registered.push(entry);
        return { dispose: () => {} };
      },
    };
    const packRegistry = new UserPackRegistry();
    const devLog = makeDevLog().subsystem;
    const defaults = {
      id: "charminal-default",
      name: "Charminal",
      reflex: {
        customTriggers: [
          {
            id: "default:idle-shoot",
            match: () => null,
          },
        ],
        responses: {
          "mischievous-shoot": { handlers: [{ handler: async () => {} }] },
        },
      },
      world: { body: "vrm:default", voice: "voice:default", space: "space:default" },
      logReading: { readWhen: { kind: "session-boundary" }, framing: "own", windowSize: 10 },
    } satisfies PersonaDefinition;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("私は最小住人。", { status: 200 })) as typeof fetch;

    try {
      const result = await loadSingleUserPack(
        {
          id: "minimal-persona",
          kind: "persona",
          entryPath: "/fake/minimal-persona/persona.js",
        },
        {
          effectPackRunner: runner,
          personaRegistry: persona,
          scenePackRegistry: makeFakeScenePackRegistry(),
          ambientUiPackRegistry: makeFakeAmbientUiPackRegistry(),
          packRegistry,
          personaDefaults: defaults,
          devLog,
          importModule: async () => ({
            default: {
              id: "minimal-persona",
              name: "最小住人",
            },
          }),
        },
      );

      expect(result.status).toBe("loaded");
      expect(registered).toHaveLength(1);
      expect(registered[0].persona.id).toBe("minimal-persona");
      expect(registered[0].persona.thinking?.systemPromptAddition).toBe("私は最小住人。");
      expect(registered[0].persona.reflex).toBe(defaults.reflex);
      expect(registered[0].persona.world).toBe(defaults.world);
      expect(registered[0].persona.logReading).toBe(defaults.logReading);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Tests for loadUserPacks — Phase 1-a の static user pack load。
 *
 * effectPackRunner / personaRegistry は構造的 interface に narrow してあるので、
 * ここでは real instance を組まずに stub で直接検証する。
 */

import type { EffectDefinition, PersonaDefinition } from "@charminal/sdk";
import { describe, expect, it } from "vitest";
import { createSubsystemLog, DevLog, type SubsystemLog } from "../../core/dev-log";
import { Time } from "../../core/time";
import {
  type EffectRegistrar,
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
  readonly registered: PersonaDefinition[];
  readonly disposedIds: string[];
}

const makePersonaRegistrar = (
  opts: { rejectIds?: ReadonlySet<string> } = {},
): PersonaRegistrarFake => {
  const registered: PersonaDefinition[] = [];
  const disposedIds: string[] = [];
  return {
    registered,
    disposedIds,
    register(def) {
      if (opts.rejectIds?.has(def.id)) {
        throw new Error(`PersonaRegistry: packId already registered: ${def.id}`);
      }
      registered.push(def);
      return {
        dispose: () => {
          disposedIds.push(def.id);
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
      devLog: subsystem,
      packRegistry: new UserPackRegistry(),
      fetchPackEntries: async () => entries,
      importModule: async (p) => modules.get(p),
    });

    expect(effectReg.registered).toEqual([validEffectPack]);
    expect(personaReg.registered).toEqual([validPersonaPack]);
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
    const entries: UserPackEntry[] = [{ id: "my-scene", kind: "scene", entryPath: "/p/scene.js" }];

    const result = await loadUserPacks({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      devLog: subsystem,
      packRegistry: new UserPackRegistry(),
      fetchPackEntries: async () => entries,
      importModule: async () => ({ default: {} }),
    });

    expect(result.loaded).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(log.read().some((e) => (e.note ?? "").includes("scene"))).toBe(true);
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
      devLog: subsystem,
      packRegistry: registry,
      fetchPackEntries: async () => entries,
      importModule: async () => ({ default: secondPack }),
    });
    expect(effectReg.registered).toHaveLength(2);
    expect(effectReg.disposedIds).toEqual(["hot"]);
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
    const personaReg: PersonaRegistrar & { registered: PersonaDefinition[] } = {
      registered: [],
      register(def) {
        if (seen.has(def.id)) {
          throw new Error(`PersonaRegistry: packId already registered: ${def.id}`);
        }
        seen.add(def.id);
        personaReg.registered.push(def);
        return {
          dispose: () => {
            seen.delete(def.id);
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
      devLog: subsystem,
      packRegistry: registry,
      fetchPackEntries: async () => entries,
      importModule: async () => ({ default: persona }),
    });

    const result = await loadUserPacks({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
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

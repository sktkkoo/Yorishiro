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
}

const makeEffectRegistrar = (): EffectRegistrarFake => {
  const registered: EffectDefinition[] = [];
  return {
    registered,
    register(pack) {
      registered.push(pack);
      return { dispose: () => {} };
    },
  };
};

interface PersonaRegistrarFake extends PersonaRegistrar {
  readonly registered: PersonaDefinition[];
}

const makePersonaRegistrar = (
  opts: { rejectIds?: ReadonlySet<string> } = {},
): PersonaRegistrarFake => {
  const registered: PersonaDefinition[] = [];
  return {
    registered,
    register(def) {
      if (opts.rejectIds?.has(def.id)) {
        throw new Error(`PersonaRegistry: packId already registered: ${def.id}`);
      }
      registered.push(def);
      return { dispose: () => {} };
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
      fetchPackEntries: async () => entries,
      importModule: async () => ({ /* no default */ notDefault: 1 }),
    });

    expect(effectReg.registered).toEqual([]);
    expect(result.loaded).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ id: "nodefault", kind: "effect" });
    expect(result.failed[0].error).toMatch(/default/i);
  });
});

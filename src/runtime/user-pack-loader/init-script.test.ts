/**
 * Tests for loadInitScript — ~/.charminal/init.js の実行。
 *
 * user が書く init.js は `export default (ctx) => { ... }` の形で、ctx の
 * registerEffect / registerPersona で pack を登録する。loader は validator を
 * 内部で通してから registrar に渡す。
 */

import type { EffectDefinition, PersonaDefinition, SpaceEffectRequest } from "@charminal/sdk";
import { describe, expect, it } from "vitest";
import { createSubsystemLog, DevLog, type SubsystemLog } from "../../core/dev-log";
import { Time } from "../../core/time";
import { type CharminalInitContext, type EffectRequester, loadInitScript } from "./init-script";
import type { EffectRegistrar, PersonaRegistrar } from "./user-pack-loader";

// ─── fixtures ─────────────────────────────────────────────────────

const validEffectPack: EffectDefinition = {
  id: "init-flash",
  type: "effect",
  run: async () => {},
};

const validPersonaPack = {
  id: "init-persona",
  name: "Init Persona",
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

const makePersonaRegistrar = (): PersonaRegistrarFake => {
  const registered: PersonaDefinition[] = [];
  return {
    registered,
    register(def) {
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
  return { log, subsystem: createSubsystemLog(log, "InitScript") };
};

interface EffectRequesterFake extends EffectRequester {
  readonly dispatched: SpaceEffectRequest[];
}

const makeEffectDispatcher = (): EffectRequesterFake => {
  const dispatched: SpaceEffectRequest[] = [];
  return {
    dispatched,
    dispatch(req) {
      dispatched.push(req);
    },
  };
};

// ─── tests ────────────────────────────────────────────────────────

describe("loadInitScript", () => {
  it("returns { ran: false } when init.js does not exist", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { subsystem } = makeDevLog();

    const result = await loadInitScript({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      devLog: subsystem,
      effectDispatcher: makeEffectDispatcher(),
      fetchInitScriptPath: async () => null,
      importModule: async () => ({}),
    });

    expect(result.ran).toBe(false);
    expect(result.error).toBeUndefined();
    expect(effectReg.registered).toEqual([]);
    expect(personaReg.registered).toEqual([]);
  });

  it("runs default() and registers packs via the context API", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { subsystem } = makeDevLog();

    const userDefault = (ctx: CharminalInitContext): void => {
      ctx.registerEffect(validEffectPack);
      ctx.registerPersona(validPersonaPack);
    };

    const result = await loadInitScript({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      devLog: subsystem,
      effectDispatcher: makeEffectDispatcher(),
      fetchInitScriptPath: async () => "/home/user/.charminal/init.js",
      importModule: async () => ({ default: userDefault }),
    });

    expect(result.ran).toBe(true);
    expect(result.error).toBeUndefined();
    expect(effectReg.registered).toEqual([validEffectPack]);
    expect(personaReg.registered).toEqual([validPersonaPack]);
  });

  it("awaits async default() before returning", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { subsystem } = makeDevLog();

    const userDefault = async (ctx: CharminalInitContext): Promise<void> => {
      await Promise.resolve();
      ctx.registerEffect(validEffectPack);
    };

    const result = await loadInitScript({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      devLog: subsystem,
      effectDispatcher: makeEffectDispatcher(),
      fetchInitScriptPath: async () => "/home/user/.charminal/init.js",
      importModule: async () => ({ default: userDefault }),
    });

    expect(result.ran).toBe(true);
    expect(effectReg.registered).toEqual([validEffectPack]);
  });

  it("ctx.registerEffect throws PackValidationError for invalid packs", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { subsystem } = makeDevLog();

    const userDefault = (ctx: CharminalInitContext): void => {
      ctx.registerEffect({ id: "bad" } as unknown as EffectDefinition);
    };

    const result = await loadInitScript({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      devLog: subsystem,
      effectDispatcher: makeEffectDispatcher(),
      fetchInitScriptPath: async () => "/home/user/.charminal/init.js",
      importModule: async () => ({ default: userDefault }),
    });

    expect(result.ran).toBe(false);
    expect(result.error).toMatch(/type|run/);
    expect(effectReg.registered).toEqual([]);
  });

  it("captures default() throws without rethrowing", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { log, subsystem } = makeDevLog();

    const userDefault = (): void => {
      throw new Error("user init blew up");
    };

    const result = await loadInitScript({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      devLog: subsystem,
      effectDispatcher: makeEffectDispatcher(),
      fetchInitScriptPath: async () => "/home/user/.charminal/init.js",
      importModule: async () => ({ default: userDefault }),
    });

    expect(result.ran).toBe(false);
    expect(result.error).toBe("user init blew up");
    expect(log.read().some((e) => (e.note ?? "").toLowerCase().includes("threw"))).toBe(true);
  });

  it("reports non-function default as an error", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { subsystem } = makeDevLog();

    const result = await loadInitScript({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      devLog: subsystem,
      effectDispatcher: makeEffectDispatcher(),
      fetchInitScriptPath: async () => "/home/user/.charminal/init.js",
      importModule: async () => ({ default: { not: "a function" } }),
    });

    expect(result.ran).toBe(false);
    expect(result.error).toMatch(/function/);
  });

  it("captures import failures without throwing", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { subsystem } = makeDevLog();

    const result = await loadInitScript({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      devLog: subsystem,
      effectDispatcher: makeEffectDispatcher(),
      fetchInitScriptPath: async () => "/home/user/.charminal/init.js",
      importModule: async () => {
        throw new Error("import boom");
      },
    });

    expect(result.ran).toBe(false);
    expect(result.error).toBe("import boom");
  });

  it("partial success: earlier packs stay registered even if a later call throws", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { subsystem } = makeDevLog();

    const userDefault = (ctx: CharminalInitContext): void => {
      ctx.registerEffect(validEffectPack);
      ctx.registerPersona({ id: "x" } as unknown as PersonaDefinition); // invalid: throws
    };

    const result = await loadInitScript({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      devLog: subsystem,
      effectDispatcher: makeEffectDispatcher(),
      fetchInitScriptPath: async () => "/home/user/.charminal/init.js",
      importModule: async () => ({ default: userDefault }),
    });

    expect(result.ran).toBe(false);
    expect(effectReg.registered).toEqual([validEffectPack]);
    expect(personaReg.registered).toEqual([]);
  });

  it("ctx.dispatchEffect forwards requests to the effect dispatcher", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const dispatcher = makeEffectDispatcher();
    const { subsystem } = makeDevLog();

    const userDefault = (ctx: CharminalInitContext): void => {
      ctx.dispatchEffect({
        kind: "fireworks",
        origin: { x: 0.5, y: 0.5 },
        count: 60,
        durationMs: 1200,
      });
    };

    const result = await loadInitScript({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      devLog: subsystem,
      effectDispatcher: dispatcher,
      fetchInitScriptPath: async () => "/home/user/.charminal/init.js",
      importModule: async () => ({ default: userDefault }),
    });

    expect(result.ran).toBe(true);
    expect(dispatcher.dispatched).toEqual([
      { kind: "fireworks", origin: { x: 0.5, y: 0.5 }, count: 60, durationMs: 1200 },
    ]);
  });
});

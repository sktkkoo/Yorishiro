/**
 * Tests for loadInitScript — ~/.charminal/init.js の実行。
 *
 * user が書く init.js は `export default (ctx) => { ... }` の形で、ctx の
 * registerEffect / registerPersona で pack を登録する。loader は validator を
 * 内部で通してから registrar に渡す。
 */

import type { EffectDefinition, PersonaDefinition, SpaceEffectRequest } from "@yorishiro/sdk";
import { describe, expect, it } from "vitest";
import { createSubsystemLog, DevLog, type SubsystemLog } from "../../core/dev-log";
import { Time } from "../../core/time";
import type { PersonaEntry } from "../persona-registry";
import type { InitDisposable, InitShortcutSpec } from "./init-scope";
import {
  type CharminalInitContext,
  type EffectRequester,
  loadInitScript,
  reloadInitScript,
  type ShortcutInstaller,
} from "./init-script";
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
  /** dispose() が呼ばれた pack。hot reload で旧 listener が畳まれたか検証する。 */
  readonly disposed: EffectDefinition[];
}

const makeEffectRegistrar = (): EffectRegistrarFake => {
  const registered: EffectDefinition[] = [];
  const disposed: EffectDefinition[] = [];
  return {
    registered,
    disposed,
    register(pack) {
      registered.push(pack);
      return {
        dispose: () => {
          disposed.push(pack);
        },
      };
    },
  };
};

interface PersonaRegistrarFake extends PersonaRegistrar {
  readonly registered: PersonaEntry[];
}

const makePersonaRegistrar = (): PersonaRegistrarFake => {
  const registered: PersonaEntry[] = [];
  return {
    registered,
    register(entry) {
      registered.push(entry);
      return { dispose: () => {} };
    },
  };
};

/**
 * SingleActiveRegistry の identity-based dispose を模す persona registry fake。
 * 同 id を register すると map を後勝ちで置換し、返す dispose は
 * 「map[id] が今もその entry のときだけ削除」する（置換済みの旧 handle dispose は
 * no-op）。`activeId()` で現在 active な persona id を観測する。
 */
interface LastWinsPersonaRegistrarFake extends PersonaRegistrar {
  activeId(id: string): string | null;
  readonly registeredCount: () => number;
}

const makeLastWinsPersonaRegistrar = (): LastWinsPersonaRegistrarFake => {
  const map = new Map<string, PersonaEntry>();
  let registeredCount = 0;
  return {
    register(entry) {
      registeredCount += 1;
      map.set(entry.id, entry);
      return {
        dispose: () => {
          if (map.get(entry.id) === entry) map.delete(entry.id);
        },
      };
    },
    activeId: (id) => (map.has(id) ? id : null),
    registeredCount: () => registeredCount,
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
    expect(personaReg.registered).toHaveLength(1);
    expect(personaReg.registered[0].persona).toMatchObject(validPersonaPack);
    expect(personaReg.registered[0].origin).toBe("user");
    expect(personaReg.registered[0].entryPath).toBe("/home/user/.charminal/init.js");
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

  it("ctx.emitEvent forwards synthetic events to the runtime hook", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const emitted: Array<{ name: string; payload?: unknown }> = [];
    const { subsystem } = makeDevLog();

    const userDefault = (ctx: CharminalInitContext): void => {
      ctx.emitEvent("clai:shoot", { source: "shortcut" });
    };

    const result = await loadInitScript({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      devLog: subsystem,
      effectDispatcher: makeEffectDispatcher(),
      emitEvent: (name, payload) => {
        emitted.push({ name, payload });
      },
      fetchInitScriptPath: async () => "/home/user/.charminal/init.js",
      importModule: async () => ({ default: userDefault }),
    });

    expect(result.ran).toBe(true);
    expect(emitted).toEqual([{ name: "clai:shoot", payload: { source: "shortcut" } }]);
  });

  it("ctx.setActiveUi forwards the selected UI pack id", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const selected: Array<string | null> = [];
    const { subsystem } = makeDevLog();

    const userDefault = (ctx: CharminalInitContext): void => {
      ctx.setActiveUi("camera-lighting-panel");
      ctx.setActiveUi(null);
    };

    const result = await loadInitScript({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      devLog: subsystem,
      effectDispatcher: makeEffectDispatcher(),
      setActiveUi: (id) => {
        selected.push(id);
      },
      fetchInitScriptPath: async () => "/home/user/.charminal/init.js",
      importModule: async () => ({ default: userDefault }),
    });

    expect(result.ran).toBe(true);
    expect(selected).toEqual(["camera-lighting-panel", null]);
  });

  it("ctx.getActiveUi returns the active UI id from the dep", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { subsystem } = makeDevLog();
    let observed: string | null = "unset";

    const userDefault = (ctx: CharminalInitContext): void => {
      observed = ctx.getActiveUi();
    };

    const result = await loadInitScript({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      devLog: subsystem,
      effectDispatcher: makeEffectDispatcher(),
      getActiveUi: () => "theater",
      fetchInitScriptPath: async () => "/home/user/.charminal/init.js",
      importModule: async () => ({ default: userDefault }),
    });

    expect(result.ran).toBe(true);
    expect(observed).toBe("theater");
  });

  it("ctx.getActiveUi returns null when no getActiveUi dep is provided", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { subsystem } = makeDevLog();
    let observed: string | null = "unset";

    const userDefault = (ctx: CharminalInitContext): void => {
      observed = ctx.getActiveUi();
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
    expect(observed).toBe(null);
  });
});

// ─── hot reload / lifecycle ───────────────────────────────────────

/** registerShortcut が叩く installer の fake。install/dispose を記録する。 */
const makeShortcutInstaller = (): {
  installer: ShortcutInstaller;
  installed: InitShortcutSpec[];
  disposed: number;
  fire: (specMatches: (s: InitShortcutSpec) => boolean, event: KeyboardEvent) => void;
} => {
  const installed: InitShortcutSpec[] = [];
  const handlers: Array<{ spec: InitShortcutSpec; handler: (e: KeyboardEvent) => void }> = [];
  let disposed = 0;
  const installer: ShortcutInstaller = (spec, handler) => {
    installed.push(spec);
    const entry = { spec, handler };
    handlers.push(entry);
    const disposable: InitDisposable = {
      dispose: () => {
        disposed += 1;
      },
    };
    return disposable;
  };
  return {
    installer,
    installed,
    get disposed() {
      return disposed;
    },
    fire: (specMatches, event) => {
      for (const { spec, handler } of handlers) {
        if (specMatches(spec)) handler(event);
      }
    },
  };
};

describe("init lifecycle: onDispose + registerShortcut", () => {
  it("ctx.onDispose cleanups run when the handle is disposed", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { subsystem } = makeDevLog();
    let cleaned = false;

    const userDefault = (ctx: CharminalInitContext): void => {
      ctx.onDispose(() => {
        cleaned = true;
      });
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
    expect(cleaned).toBe(false);
    result.handle.dispose();
    expect(cleaned).toBe(true);
  });

  it("registerShortcut installs via the injected installer and disposes with the scope", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { subsystem } = makeDevLog();
    const shortcuts = makeShortcutInstaller();
    let fired = 0;

    const userDefault = (ctx: CharminalInitContext): void => {
      ctx.registerShortcut({ code: "KeyF", meta: true }, () => {
        fired += 1;
      });
    };

    const result = await loadInitScript({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      devLog: subsystem,
      effectDispatcher: makeEffectDispatcher(),
      installShortcutListener: shortcuts.installer,
      fetchInitScriptPath: async () => "/home/user/.charminal/init.js",
      importModule: async () => ({ default: userDefault }),
    });

    expect(result.ran).toBe(true);
    expect(shortcuts.installed).toHaveLength(1);
    shortcuts.fire((s) => s.code === "KeyF", {} as KeyboardEvent);
    expect(fired).toBe(1);

    result.handle.dispose();
    expect(shortcuts.disposed).toBe(1);
  });
});

describe("reloadInitScript", () => {
  it("disposes the previous scope and activates the new one on success", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { subsystem } = makeDevLog();
    const cleaned: string[] = [];

    const makeDeps = (tag: string) => ({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      devLog: subsystem,
      effectDispatcher: makeEffectDispatcher(),
      fetchInitScriptPath: async () => "/home/user/.charminal/init.js",
      importModule: async () => ({
        default: (ctx: CharminalInitContext) => {
          ctx.onDispose(() => cleaned.push(tag));
        },
      }),
    });

    const first = await loadInitScript(makeDeps("first"));
    expect(first.ran).toBe(true);

    const reloaded = await reloadInitScript(makeDeps("second"), first.handle);
    expect(reloaded.ran).toBe(true);
    // old scope disposed, new scope not yet
    expect(cleaned).toEqual(["first"]);

    reloaded.handle.dispose();
    expect(cleaned).toEqual(["first", "second"]);
  });

  it("keeps the previous scope when the reload fails", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { subsystem } = makeDevLog();
    const cleaned: string[] = [];
    const stagedDisposed: string[] = [];

    const goodDeps = {
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      devLog: subsystem,
      effectDispatcher: makeEffectDispatcher(),
      fetchInitScriptPath: async () => "/home/user/.charminal/init.js",
      importModule: async () => ({
        default: (ctx: CharminalInitContext) => {
          ctx.onDispose(() => cleaned.push("good"));
        },
      }),
    };

    const first = await loadInitScript(goodDeps);
    expect(first.ran).toBe(true);

    const badDeps = {
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      devLog: subsystem,
      effectDispatcher: makeEffectDispatcher(),
      fetchInitScriptPath: async () => "/home/user/.charminal/init.js",
      importModule: async () => ({
        default: (ctx: CharminalInitContext) => {
          // stage a cleanup, then throw — the staged scope must be disposed.
          ctx.onDispose(() => stagedDisposed.push("staged"));
          throw new Error("bad edit");
        },
      }),
    };

    const reloaded = await reloadInitScript(badDeps, first.handle);
    expect(reloaded.ran).toBe(false);
    expect(reloaded.error).toBe("bad edit");
    // previous scope kept alive (not disposed)…
    expect(cleaned).toEqual([]);
    // …and the failed staging scope was cleaned up.
    expect(stagedDisposed).toEqual(["staged"]);
    // returned handle is the previous one
    expect(reloaded.handle).toBe(first.handle);
  });

  it("handles reload when there is no previous scope", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { subsystem } = makeDevLog();

    const reloaded = await reloadInitScript(
      {
        effectPackRunner: effectReg,
        personaRegistry: personaReg,
        devLog: subsystem,
        effectDispatcher: makeEffectDispatcher(),
        fetchInitScriptPath: async () => "/home/user/.charminal/init.js",
        importModule: async () => ({ default: (_ctx: CharminalInitContext) => {} }),
      },
      null,
    );

    expect(reloaded.ran).toBe(true);
    expect(reloaded.handle).toBeDefined();
  });
});

// ─── transactional register: effect + persona ─────────────────────

describe("register* hot-reload semantics", () => {
  it("registers effects immediately and disposes them with the scope (no listener leak)", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { subsystem } = makeDevLog();

    const deps = {
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      devLog: subsystem,
      effectDispatcher: makeEffectDispatcher(),
      fetchInitScriptPath: async () => "/home/user/.charminal/init.js",
      importModule: async () => ({
        default: (ctx: CharminalInitContext) => {
          ctx.registerEffect(validEffectPack);
        },
      }),
    };

    const result = await loadInitScript(deps);
    expect(result.ran).toBe(true);
    expect(effectReg.registered).toEqual([validEffectPack]);
    expect(effectReg.disposed).toEqual([]);

    // scope dispose → effect listener も外れる（reload で旧 listener が累積しない）。
    result.handle.dispose();
    expect(effectReg.disposed).toEqual([validEffectPack]);
  });

  it("a successful reload disposes the previous effect listener exactly once", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { subsystem } = makeDevLog();

    const deps = {
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      devLog: subsystem,
      effectDispatcher: makeEffectDispatcher(),
      fetchInitScriptPath: async () => "/home/user/.charminal/init.js",
      importModule: async () => ({
        default: (ctx: CharminalInitContext) => {
          ctx.registerEffect(validEffectPack);
        },
      }),
    };

    const first = await loadInitScript(deps);
    const reloaded = await reloadInitScript(deps, first.handle);
    expect(reloaded.ran).toBe(true);
    // 2 回 register（旧+新）したが、旧 1 つだけ dispose 済み。
    expect(effectReg.registered).toHaveLength(2);
    expect(effectReg.disposed).toHaveLength(1);
  });

  it("defers persona registration until the run succeeds (commit)", async () => {
    const effectReg = makeEffectRegistrar();
    const persona = makeLastWinsPersonaRegistrar();
    const { subsystem } = makeDevLog();

    const result = await loadInitScript({
      effectPackRunner: effectReg,
      personaRegistry: persona,
      devLog: subsystem,
      effectDispatcher: makeEffectDispatcher(),
      fetchInitScriptPath: async () => "/home/user/.charminal/init.js",
      importModule: async () => ({
        default: (ctx: CharminalInitContext) => {
          ctx.registerPersona(validPersonaPack);
        },
      }),
    });

    expect(result.ran).toBe(true);
    expect(persona.activeId("init-persona")).toBe("init-persona");
    expect(persona.registeredCount()).toBe(1);
  });

  it("a failed reload that registered a persona keeps the previous persona", async () => {
    const effectReg = makeEffectRegistrar();
    const persona = makeLastWinsPersonaRegistrar();
    const { subsystem } = makeDevLog();

    // 1st: register persona "init-persona" successfully.
    const first = await loadInitScript({
      effectPackRunner: effectReg,
      personaRegistry: persona,
      devLog: subsystem,
      effectDispatcher: makeEffectDispatcher(),
      fetchInitScriptPath: async () => "/home/user/.charminal/init.js",
      importModule: async () => ({
        default: (ctx: CharminalInitContext) => {
          ctx.registerPersona(validPersonaPack);
        },
      }),
    });
    expect(first.ran).toBe(true);
    expect(persona.activeId("init-persona")).toBe("init-persona");

    // 2nd (reload): register a *valid* persona with the same id, then throw.
    const reloaded = await reloadInitScript(
      {
        effectPackRunner: effectReg,
        personaRegistry: persona,
        devLog: subsystem,
        effectDispatcher: makeEffectDispatcher(),
        fetchInitScriptPath: async () => "/home/user/.charminal/init.js",
        importModule: async () => ({
          default: (ctx: CharminalInitContext) => {
            ctx.registerPersona(validPersonaPack);
            throw new Error("late failure after registerPersona");
          },
        }),
      },
      first.handle,
    );

    expect(reloaded.ran).toBe(false);
    // commit が走っていないので 2 回目の register は起きず、前の persona が無傷。
    expect(persona.registeredCount()).toBe(1);
    expect(persona.activeId("init-persona")).toBe("init-persona");
    expect(reloaded.handle).toBe(first.handle);
  });
});

// ─── deleting init.js ─────────────────────────────────────────────

describe("reloadInitScript: file removal", () => {
  it("treats a missing init.js as a clean transition to an empty scope", async () => {
    const effectReg = makeEffectRegistrar();
    const personaReg = makePersonaRegistrar();
    const { subsystem } = makeDevLog();
    const cleaned: string[] = [];

    const first = await loadInitScript({
      effectPackRunner: effectReg,
      personaRegistry: personaReg,
      devLog: subsystem,
      effectDispatcher: makeEffectDispatcher(),
      fetchInitScriptPath: async () => "/home/user/.charminal/init.js",
      importModule: async () => ({
        default: (ctx: CharminalInitContext) => {
          ctx.onDispose(() => cleaned.push("first"));
        },
      }),
    });
    expect(first.ran).toBe(true);

    // init.js deleted → fetchInitScriptPath returns null.
    const reloaded = await reloadInitScript(
      {
        effectPackRunner: effectReg,
        personaRegistry: personaReg,
        devLog: subsystem,
        effectDispatcher: makeEffectDispatcher(),
        fetchInitScriptPath: async () => null,
        importModule: async () => ({}),
      },
      first.handle,
    );

    expect(reloaded.ran).toBe(false);
    expect(reloaded.missing).toBe(true);
    expect(reloaded.error).toBeUndefined();
    // 旧 scope は畳まれている（古い shortcut / listener が残らない）。
    expect(cleaned).toEqual(["first"]);
    // 新しい handle は空 scope（前の handle ではない）。
    expect(reloaded.handle).not.toBe(first.handle);
  });
});

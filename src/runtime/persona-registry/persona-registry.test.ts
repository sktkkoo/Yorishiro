import type {
  PersonaContext,
  PersonaDefinition,
  PersonaHandler,
  ReactionType,
  Trigger,
  UserInputEvent,
} from "@charminal/sdk";
import { describe, expect, it, vi } from "vitest";
import { Time } from "../../core/time";
import { EventBus, type EventBusLogger, type PackSource } from "../event-bus";
import { PersonaRegistry } from "./persona-registry";
import type { PersonaContextFactory, PersonaContextInputs } from "./stub-context";

// ─── helpers ────────────────────────────────────────────────────────

/** Trigger that only matches user-input events. */
const userInputTrigger = (reaction: ReactionType, id = "t-user"): Trigger => ({
  id,
  match: (event) => (event.kind === "user-input" ? { reaction } : null),
});

/** Trigger that only matches synthetic events by name. */
const syntheticTrigger = (
  name: string,
  reaction: ReactionType = "curious",
  id = "t-synth",
): Trigger => ({
  id,
  match: (event) =>
    event.kind === "synthetic" && event.name === name ? { reaction, payload: event.payload } : null,
});

const makeUserEvent = (text = "hi", timestamp = 1000): UserInputEvent => ({
  kind: "user-input",
  text,
  timestamp,
});

interface MakePersonaOverrides {
  id?: string;
  name?: string;
  customTriggers?: ReadonlyArray<Trigger>;
  responses?: PersonaDefinition["reflex"]["responses"];
}

const makePersona = (overrides: MakePersonaOverrides = {}): PersonaDefinition => ({
  id: overrides.id ?? "alice",
  name: overrides.name ?? "Alice",
  thinking: { systemPromptAddition: "" },
  reflex: {
    customTriggers: overrides.customTriggers,
    responses: overrides.responses ?? {},
  },
  world: { body: "", voice: "", space: "" },
  logReading: { readWhen: { kind: "never" }, framing: "absent", windowSize: 0 },
});

interface TestHarnessOpts {
  random?: () => number;
  clock?: () => number;
  maxDepth?: number;
  contextFactory?: PersonaContextFactory;
}

interface TestHarness {
  registry: PersonaRegistry;
  bus: EventBus;
  time: Time;
  logger: EventBusLogger & {
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  contextFactoryCalls: PersonaContextInputs[];
}

/**
 * Wires up a Time + EventBus + PersonaRegistry using synchronous scheduling so
 * tests can assert handler invocations inline.
 */
const createTestHarness = (opts: TestHarnessOpts = {}): TestHarness => {
  const time = new Time({ clock: opts.clock ?? (() => 1000) });
  const logger = {
    warn: vi.fn<(message: string, meta?: Record<string, unknown>) => void>(),
    error: vi.fn<(message: string, meta?: Record<string, unknown>) => void>(),
  };
  const bus = new EventBus({
    time,
    logger,
    schedule: (task) => task(),
    ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
  });
  const contextFactoryCalls: PersonaContextInputs[] = [];
  const spyFactory: PersonaContextFactory = (inputs) => {
    contextFactoryCalls.push(inputs);
    return makeStubContext(inputs);
  };
  const registry = new PersonaRegistry({
    bus,
    time,
    contextFactory: opts.contextFactory ?? spyFactory,
    logger,
    random: opts.random ?? (() => 0),
  });
  return { registry, bus, time, logger, contextFactoryCalls };
};

/**
 * Constructs a minimal PersonaContext from the inputs supplied by the
 * registry — used by the spy factory so handlers can see `ctx.event`,
 * `ctx.persona`, `ctx.emitEvent`, `ctx.signal`, and `ctx.time`. Other sub-APIs
 * are intentionally unused by the test suite and are filled with tiny
 * objects that would fail loudly if accidentally called.
 */
const makeStubContext = (inputs: PersonaContextInputs): PersonaContext => {
  const notImplemented = (label: string) => () => {
    throw new Error(`stub ${label} was called by a test handler — not expected`);
  };
  return {
    event: inputs.event,
    persona: inputs.persona,
    time: inputs.time,
    emitEvent: inputs.emitEvent,
    character: {
      play: notImplemented("character.play"),
      express: notImplemented("character.express"),
      gaze: notImplemented("character.gaze"),
      interrupt: notImplemented("character.interrupt"),
    },
    voice: {
      say: notImplemented("voice.say"),
      play: notImplemented("voice.play"),
      silence: notImplemented("voice.silence"),
    },
    space: {
      injectEffect: notImplemented("space.injectEffect"),
    },
    log: {
      write: () => {},
      tail: () => [],
      read: () => [],
    },
    memory: {
      persona: { get: () => undefined, set: () => {}, delete: () => {} },
      core: { get: () => undefined, set: () => {}, delete: () => {} },
    },
    terminal: {
      output: () => "",
      session: { pid: 0, cwd: "", startedAt: 0 },
    },
    charm: async () => {},
    signal: inputs.signal,
  };
};

// ─── tests ──────────────────────────────────────────────────────────

describe("PersonaRegistry", () => {
  describe("registration / lifecycle", () => {
    it("constructs with just a bus and time", () => {
      const time = new Time({ clock: () => 0 });
      const bus = new EventBus({ time, schedule: (task) => task() });
      expect(() => new PersonaRegistry({ bus, time })).not.toThrow();
    });

    it("register() returns a Registration, has() true, size() 1", () => {
      const { registry } = createTestHarness();
      const reg = registry.register(makePersona());
      expect(typeof reg.dispose).toBe("function");
      expect(registry.has("alice")).toBe(true);
      expect(registry.size()).toBe(1);
    });

    it("dispose() tears down has() / size()", () => {
      const { registry } = createTestHarness();
      const reg = registry.register(makePersona());
      reg.dispose();
      expect(registry.has("alice")).toBe(false);
      expect(registry.size()).toBe(0);
    });

    it("double register with same id throws", () => {
      const { registry } = createTestHarness();
      registry.register(makePersona({ id: "dup" }));
      expect(() => registry.register(makePersona({ id: "dup" }))).toThrow(/dup/);
    });

    it("after dispose, registering the same id again succeeds", () => {
      const { registry } = createTestHarness();
      const reg = registry.register(makePersona({ id: "reborn" }));
      reg.dispose();
      expect(() => registry.register(makePersona({ id: "reborn" }))).not.toThrow();
      expect(registry.has("reborn")).toBe(true);
    });

    it("persona without customTriggers still registers and tracks state", () => {
      const { registry } = createTestHarness();
      const def = makePersona({ id: "silent" });
      expect(() => registry.register(def)).not.toThrow();
      expect(registry.has("silent")).toBe(true);
      expect(registry.size()).toBe(1);
    });
  });

  describe("bus wiring", () => {
    it("one custom trigger → bus.register called once with persona source", () => {
      const { registry, bus } = createTestHarness();
      const spy = vi.spyOn(bus, "register");
      const trigger = userInputTrigger("pleased");
      registry.register(makePersona({ customTriggers: [trigger] }));

      expect(spy).toHaveBeenCalledTimes(1);
      const [registeredTrigger, , source] = spy.mock.calls[0];
      expect(registeredTrigger).toBe(trigger);
      expect(source).toEqual({ type: "persona", packId: "alice" });
    });

    it("three custom triggers → three bus registrations with same source", () => {
      const { registry, bus } = createTestHarness();
      const spy = vi.spyOn(bus, "register");
      const triggers: Trigger[] = [
        userInputTrigger("pleased", "t1"),
        userInputTrigger("curious", "t2"),
        userInputTrigger("focused", "t3"),
      ];
      registry.register(makePersona({ customTriggers: triggers }));

      expect(spy).toHaveBeenCalledTimes(3);
      for (const call of spy.mock.calls) {
        const source = call[2] as PackSource;
        expect(source).toEqual({ type: "persona", packId: "alice" });
      }
    });

    it("dispose removes all bus registrations for the persona", () => {
      const { registry, bus } = createTestHarness();
      const handler = vi.fn<PersonaHandler>(async () => {});
      const reg = registry.register(
        makePersona({
          customTriggers: [userInputTrigger("pleased")],
          responses: { pleased: { handlers: [{ handler }] } },
        }),
      );
      reg.dispose();

      bus.dispatch(makeUserEvent());
      expect(handler).not.toHaveBeenCalled();
    });

    it("two personas register → 1+1 bus registrations with different sources", () => {
      const { registry, bus } = createTestHarness();
      const spy = vi.spyOn(bus, "register");
      registry.register(
        makePersona({ id: "alice", customTriggers: [userInputTrigger("pleased", "alice-t")] }),
      );
      registry.register(
        makePersona({ id: "bob", customTriggers: [userInputTrigger("curious", "bob-t")] }),
      );

      expect(spy).toHaveBeenCalledTimes(2);
      const sources = spy.mock.calls.map((call) => call[2] as PackSource);
      expect(sources).toEqual([
        { type: "persona", packId: "alice" },
        { type: "persona", packId: "bob" },
      ]);
    });
  });

  describe("responses lookup and execution", () => {
    it("single handler receives a PersonaContext whose event / persona match", () => {
      const { registry, bus } = createTestHarness();
      const handler = vi.fn<PersonaHandler>(async () => {});
      const trigger = userInputTrigger("pleased");
      registry.register(
        makePersona({
          id: "alice",
          name: "Alice",
          customTriggers: [trigger],
          responses: { pleased: { handlers: [{ handler }] } },
        }),
      );

      const event = makeUserEvent("yo");
      bus.dispatch(event);

      expect(handler).toHaveBeenCalledTimes(1);
      const [ctx] = handler.mock.calls[0];
      expect(ctx.event.triggeredBy).toBe(event);
      expect(ctx.event.reaction).toBe("pleased");
      expect(ctx.persona.id).toBe("alice");
      expect(ctx.persona.name).toBe("Alice");
    });

    it("no responses entry for the reaction → warn logged, handler not called", () => {
      const { registry, bus, logger } = createTestHarness();
      const handler = vi.fn<PersonaHandler>(async () => {});
      registry.register(
        makePersona({
          customTriggers: [userInputTrigger("pleased")],
          // responses has no `pleased` entry
          responses: { curious: { handlers: [{ handler }] } },
        }),
      );

      bus.dispatch(makeUserEvent());
      expect(handler).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("empty handler set → warn logged, nothing fires", () => {
      const { registry, bus, logger } = createTestHarness();
      registry.register(
        makePersona({
          customTriggers: [userInputTrigger("pleased")],
          responses: { pleased: { handlers: [] } },
        }),
      );

      bus.dispatch(makeUserEvent());
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("context has a live AbortSignal that is not aborted", () => {
      const { registry, bus } = createTestHarness();
      let seen: AbortSignal | undefined;
      const handler = vi.fn<PersonaHandler>(async (ctx) => {
        seen = ctx.signal;
      });
      registry.register(
        makePersona({
          customTriggers: [userInputTrigger("pleased")],
          responses: { pleased: { handlers: [{ handler }] } },
        }),
      );

      bus.dispatch(makeUserEvent());
      expect(seen).toBeDefined();
      expect(seen?.aborted).toBe(false);
    });

    it("contextFactory receives inputs with event, persona, time, emitEvent", () => {
      const { registry, bus, time, contextFactoryCalls } = createTestHarness();
      const handler = vi.fn<PersonaHandler>(async () => {});
      registry.register(
        makePersona({
          id: "alice",
          name: "Alice",
          customTriggers: [userInputTrigger("pleased")],
          responses: { pleased: { handlers: [{ handler }] } },
        }),
      );

      const event = makeUserEvent();
      bus.dispatch(event);
      expect(contextFactoryCalls).toHaveLength(1);
      const inputs = contextFactoryCalls[0];
      expect(inputs.event.triggeredBy).toBe(event);
      expect(inputs.persona).toEqual({ id: "alice", name: "Alice" });
      expect(inputs.time).toBe(time);
      expect(typeof inputs.emitEvent).toBe("function");
    });
  });

  describe("weighted selection", () => {
    const dispatchAndExpectOne = (random: () => number) => {
      const { registry, bus } = createTestHarness({ random });
      const a = vi.fn<PersonaHandler>(async () => {});
      const b = vi.fn<PersonaHandler>(async () => {});
      return { registry, bus, a, b };
    };

    it("single candidate is always selected", () => {
      const { registry, bus, a } = dispatchAndExpectOne(() => 0);
      const b = vi.fn<PersonaHandler>(async () => {});
      registry.register(
        makePersona({
          customTriggers: [userInputTrigger("pleased")],
          responses: { pleased: { handlers: [{ handler: a }] } },
        }),
      );
      bus.dispatch(makeUserEvent());
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).not.toHaveBeenCalled();
    });

    it("two equal-weight candidates, random=0.3 → first selected", () => {
      const { registry, bus, a, b } = dispatchAndExpectOne(() => 0.3);
      registry.register(
        makePersona({
          customTriggers: [userInputTrigger("pleased")],
          responses: { pleased: { handlers: [{ handler: a }, { handler: b }] } },
        }),
      );
      bus.dispatch(makeUserEvent());
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).not.toHaveBeenCalled();
    });

    it("two equal-weight candidates, random=0.7 → second selected", () => {
      const { registry, bus, a, b } = dispatchAndExpectOne(() => 0.7);
      registry.register(
        makePersona({
          customTriggers: [userInputTrigger("pleased")],
          responses: { pleased: { handlers: [{ handler: a }, { handler: b }] } },
        }),
      );
      bus.dispatch(makeUserEvent());
      expect(a).not.toHaveBeenCalled();
      expect(b).toHaveBeenCalledTimes(1);
    });

    it("weights 3+1, random=0.5 → first selected (threshold 2 < weight 3)", () => {
      const { registry, bus, a, b } = dispatchAndExpectOne(() => 0.5);
      registry.register(
        makePersona({
          customTriggers: [userInputTrigger("pleased")],
          responses: {
            pleased: {
              handlers: [
                { handler: a, weight: 3 },
                { handler: b, weight: 1 },
              ],
            },
          },
        }),
      );
      bus.dispatch(makeUserEvent());
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).not.toHaveBeenCalled();
    });

    it("weights 3+1, random=0.9 → second selected", () => {
      const { registry, bus, a, b } = dispatchAndExpectOne(() => 0.9);
      registry.register(
        makePersona({
          customTriggers: [userInputTrigger("pleased")],
          responses: {
            pleased: {
              handlers: [
                { handler: a, weight: 3 },
                { handler: b, weight: 1 },
              ],
            },
          },
        }),
      );
      bus.dispatch(makeUserEvent());
      expect(a).not.toHaveBeenCalled();
      expect(b).toHaveBeenCalledTimes(1);
    });

    it("missing weight defaults to 1", () => {
      // weights [undefined=1, 3] total=4; random 0.1 -> threshold 0.4 -> first
      const { registry, bus, a, b } = dispatchAndExpectOne(() => 0.1);
      registry.register(
        makePersona({
          customTriggers: [userInputTrigger("pleased")],
          responses: {
            pleased: { handlers: [{ handler: a }, { handler: b, weight: 3 }] },
          },
        }),
      );
      bus.dispatch(makeUserEvent());
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).not.toHaveBeenCalled();
    });

    it("all-zero weights → warn, no handler called", () => {
      const { registry, bus, logger } = createTestHarness({ random: () => 0.5 });
      const a = vi.fn<PersonaHandler>(async () => {});
      const b = vi.fn<PersonaHandler>(async () => {});
      registry.register(
        makePersona({
          customTriggers: [userInputTrigger("pleased")],
          responses: {
            pleased: {
              handlers: [
                { handler: a, weight: 0 },
                { handler: b, weight: 0 },
              ],
            },
          },
        }),
      );
      bus.dispatch(makeUserEvent());
      expect(a).not.toHaveBeenCalled();
      expect(b).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe("cooldown", () => {
    it("first fire at ts=1000 records lastFiredAt and second fire at 1500 with cooldownMs=1000 is blocked", () => {
      const { registry, bus, logger } = createTestHarness();
      const handler = vi.fn<PersonaHandler>(async () => {});
      registry.register(
        makePersona({
          customTriggers: [userInputTrigger("pleased")],
          responses: { pleased: { handlers: [{ handler, cooldownMs: 1000 }] } },
        }),
      );

      bus.dispatch(makeUserEvent("one", 1000));
      expect(handler).toHaveBeenCalledTimes(1);

      bus.dispatch(makeUserEvent("two", 1500));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("second fire exactly at cooldown boundary is allowed", () => {
      const { registry, bus } = createTestHarness();
      const handler = vi.fn<PersonaHandler>(async () => {});
      registry.register(
        makePersona({
          customTriggers: [userInputTrigger("pleased")],
          responses: { pleased: { handlers: [{ handler, cooldownMs: 1000 }] } },
        }),
      );

      bus.dispatch(makeUserEvent("one", 1000));
      bus.dispatch(makeUserEvent("two", 2000));
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("one candidate in cooldown, another not → the other is selected", () => {
      const { registry, bus } = createTestHarness({ random: () => 0 });
      const a = vi.fn<PersonaHandler>(async () => {});
      const b = vi.fn<PersonaHandler>(async () => {});
      registry.register(
        makePersona({
          customTriggers: [userInputTrigger("pleased")],
          responses: {
            pleased: {
              handlers: [
                { handler: a, cooldownMs: 5000 },
                { handler: b, cooldownMs: 0 },
              ],
            },
          },
        }),
      );

      // First dispatch: random=0 picks index 0 (a).
      bus.dispatch(makeUserEvent("one", 1000));
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).not.toHaveBeenCalled();

      // Second dispatch 500ms later: a is still on cooldown (500 < 5000),
      // so only b is eligible — b must fire regardless of random.
      bus.dispatch(makeUserEvent("two", 1500));
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it("all candidates in cooldown → warn, nothing fires", () => {
      const { registry, bus, logger } = createTestHarness({ random: () => 0 });
      const a = vi.fn<PersonaHandler>(async () => {});
      const b = vi.fn<PersonaHandler>(async () => {});
      registry.register(
        makePersona({
          customTriggers: [userInputTrigger("pleased")],
          responses: {
            pleased: {
              handlers: [
                { handler: a, cooldownMs: 5000 },
                { handler: b, cooldownMs: 5000 },
              ],
            },
          },
        }),
      );

      // Fire a
      bus.dispatch(makeUserEvent("one", 1000));
      // Fire b
      bus.dispatch(makeUserEvent("two", 1100));
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);

      logger.warn.mockClear();

      // Both in cooldown: a blocked (200 < 5000), b blocked (100 < 5000).
      bus.dispatch(makeUserEvent("three", 1200));
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("cooldowns are isolated per persona", () => {
      const { registry, bus } = createTestHarness();
      const aliceHandler = vi.fn<PersonaHandler>(async () => {});
      const bobHandler = vi.fn<PersonaHandler>(async () => {});
      registry.register(
        makePersona({
          id: "alice",
          customTriggers: [userInputTrigger("pleased", "alice-t")],
          responses: { pleased: { handlers: [{ handler: aliceHandler, cooldownMs: 10_000 }] } },
        }),
      );
      registry.register(
        makePersona({
          id: "bob",
          customTriggers: [userInputTrigger("pleased", "bob-t")],
          responses: { pleased: { handlers: [{ handler: bobHandler, cooldownMs: 10_000 }] } },
        }),
      );

      bus.dispatch(makeUserEvent("one", 1000));
      expect(aliceHandler).toHaveBeenCalledTimes(1);
      expect(bobHandler).toHaveBeenCalledTimes(1);

      // Alice's fire at 1000 should not influence Bob's cooldown the next time.
      bus.dispatch(makeUserEvent("two", 1500));
      // Both still in cooldown (500ms < 10000ms) — this assertion just
      // verifies they are INDEPENDENTLY tracked, not that the second call
      // fires. But they both are blocked by the same rule.
      expect(aliceHandler).toHaveBeenCalledTimes(1);
      expect(bobHandler).toHaveBeenCalledTimes(1);

      // Now jump past Alice's cooldown for Alice only by disposing Bob.
      bus.dispatch(makeUserEvent("three", 11_500));
      expect(aliceHandler).toHaveBeenCalledTimes(2);
      expect(bobHandler).toHaveBeenCalledTimes(2);
    });
  });

  describe("per-pack bound emitEvent", () => {
    it("ctx.emitEvent forwards to bus.emitSynthetic with persona source and correct depth", () => {
      const { registry, bus } = createTestHarness();
      const spy = vi.spyOn(bus, "emitSynthetic");
      const handler = vi.fn<PersonaHandler>(async (ctx) => {
        ctx.emitEvent("X", { hello: "world" });
      });
      registry.register(
        makePersona({
          id: "alice",
          customTriggers: [userInputTrigger("pleased")],
          responses: { pleased: { handlers: [{ handler }] } },
        }),
      );

      bus.dispatch(makeUserEvent());
      expect(spy).toHaveBeenCalledTimes(1);
      const [source, name, payload, parentDepth] = spy.mock.calls[0];
      expect(source).toEqual({ type: "persona", packId: "alice" });
      expect(name).toBe("X");
      expect(payload).toEqual({ hello: "world" });
      expect(parentDepth).toBe(1);
    });

    it("two personas each emit with their own packId as source", () => {
      const { registry, bus } = createTestHarness();
      const spy = vi.spyOn(bus, "emitSynthetic");
      const aliceHandler = vi.fn<PersonaHandler>(async (ctx) => {
        ctx.emitEvent("hello");
      });
      const bobHandler = vi.fn<PersonaHandler>(async (ctx) => {
        ctx.emitEvent("hello");
      });
      registry.register(
        makePersona({
          id: "alice",
          customTriggers: [userInputTrigger("pleased", "alice-t")],
          responses: { pleased: { handlers: [{ handler: aliceHandler }] } },
        }),
      );
      registry.register(
        makePersona({
          id: "bob",
          customTriggers: [userInputTrigger("pleased", "bob-t")],
          responses: { pleased: { handlers: [{ handler: bobHandler }] } },
        }),
      );

      bus.dispatch(makeUserEvent());
      expect(spy).toHaveBeenCalledTimes(2);
      const sources = spy.mock.calls.map((call) => call[0]);
      expect(sources).toContainEqual({ type: "persona", packId: "alice" });
      expect(sources).toContainEqual({ type: "persona", packId: "bob" });
    });

    it("wrapper invoked at depth N propagates to ctx.emitEvent as parentDepth=N", () => {
      const { registry, bus } = createTestHarness();
      const spy = vi.spyOn(bus, "emitSynthetic");
      const handler = vi.fn<PersonaHandler>(async (ctx) => {
        ctx.emitEvent("bounce");
      });
      // Match a synthetic event so we can push the handler to depth 2.
      registry.register(
        makePersona({
          id: "alice",
          customTriggers: [syntheticTrigger("start", "pleased", "t-start")],
          responses: { pleased: { handlers: [{ handler }] } },
        }),
      );

      bus.emitSynthetic({ type: "persona", packId: "seed" }, "start", null, 1);
      // First call was the external emit (seed → depth 2). The handler then
      // calls ctx.emitEvent("bounce") from within depth 2.
      const calls = spy.mock.calls.filter((c) => c[1] === "bounce");
      expect(calls).toHaveLength(1);
      const [, , , parentDepth] = calls[0];
      expect(parentDepth).toBe(2);
    });
  });

  describe("error isolation", () => {
    it("handler throws synchronously → error logged, registry still functional", () => {
      const { registry, bus, logger } = createTestHarness();
      const bad = vi.fn<PersonaHandler>(() => {
        throw new Error("sync boom");
      });
      registry.register(
        makePersona({
          customTriggers: [userInputTrigger("pleased")],
          responses: { pleased: { handlers: [{ handler: bad }] } },
        }),
      );

      expect(() => bus.dispatch(makeUserEvent("a", 1000))).not.toThrow();
      expect(logger.error).toHaveBeenCalled();

      // Still functional: a second dispatch (after cooldown-less handler)
      // should invoke the handler again.
      expect(() => bus.dispatch(makeUserEvent("b", 2000))).not.toThrow();
      expect(bad).toHaveBeenCalledTimes(2);
    });

    it("handler returns rejected promise → error logged, registry still functional", async () => {
      const { registry, bus, logger } = createTestHarness();
      const bad = vi.fn<PersonaHandler>(() => Promise.reject(new Error("async boom")));
      registry.register(
        makePersona({
          customTriggers: [userInputTrigger("pleased")],
          responses: { pleased: { handlers: [{ handler: bad }] } },
        }),
      );

      bus.dispatch(makeUserEvent());
      // flush rejection
      await Promise.resolve();
      await Promise.resolve();
      expect(logger.error).toHaveBeenCalled();
    });
  });
});

import type {
  PersonaContext,
  PersonaDefinition,
  PersonaHandler,
  ReactionType,
  Trigger,
  UserInputEvent,
} from "@yorishiro/sdk";
import { describe, expect, it, vi } from "vitest";
import { Time } from "../../core/time";
import { EventBus, type EventBusLogger, type PackSource } from "../event-bus";
import type { PersonaContextFactory, PersonaContextInputs } from "../persona-registry/stub-context";
import type {
  Disposable,
  PersonaEntry,
  PersonaRegistry as PersonaRegistryInterface,
} from "../persona-registry/types";
import { PersonaReflexDispatcher } from "./persona-reflex-dispatcher";

// ─── helpers ────────────────────────────────────────────────────────

const userInputTrigger = (reaction: ReactionType, id = "t-user"): Trigger => ({
  id,
  match: (event) => (event.kind === "user-input" ? { reaction } : null),
});

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
  responses?: NonNullable<PersonaDefinition["reflex"]>["responses"];
  /** reflex 自体を無くしたいケース（minimal pack）。 */
  noReflex?: boolean;
}

const makePersona = (overrides: MakePersonaOverrides = {}): PersonaDefinition => {
  const base: PersonaDefinition = {
    id: overrides.id ?? "alice",
    name: overrides.name ?? "Alice",
    thinking: { systemPromptAddition: "" },
    world: { body: "", voice: "" },
    logReading: { readWhen: { kind: "never" }, framing: "absent", windowSize: 0 },
  };
  if (overrides.noReflex === true) return base;
  return {
    ...base,
    reflex: {
      customTriggers: overrides.customTriggers,
      responses: overrides.responses ?? {},
    },
  };
};

/**
 * Fake PersonaRegistry — dispatcher の test-driving 用。subscribeActive listener
 * を捕まえて、test 側から `setActive` で active を任意に切り替える。
 */
class FakePersonaRegistry implements PersonaRegistryInterface {
  private current: PersonaDefinition | null = null;
  private listeners = new Set<(persona: PersonaDefinition | null) => void>();

  register(_entry: PersonaEntry): Disposable {
    return { dispose: () => {} };
  }

  getActivePersona(): PersonaDefinition | null {
    return this.current;
  }

  subscribeActive(listener: (persona: PersonaDefinition | null) => void): Disposable {
    this.listeners.add(listener);
    listener(this.current);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  setPrimaryPersona(_id: string | null): void {}

  getActivePersonaId(): string | null {
    return this.current?.id ?? null;
  }

  listEntries(): ReadonlyArray<PersonaEntry> {
    return [];
  }

  /** test 専用：active を切り替えて listener を fire する。 */
  setActive(persona: PersonaDefinition | null): void {
    this.current = persona;
    for (const l of Array.from(this.listeners)) l(persona);
  }
}

interface TestHarnessOpts {
  random?: () => number;
  clock?: () => number;
  maxDepth?: number;
  contextFactory?: PersonaContextFactory;
  /** dispatcher 構築時の initial active。default: null（後で setActive で driving）。 */
  initialActive?: PersonaDefinition | null;
}

interface TestHarness {
  dispatcher: PersonaReflexDispatcher;
  bus: EventBus;
  time: Time;
  registry: FakePersonaRegistry;
  logger: EventBusLogger & {
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  contextFactoryCalls: PersonaContextInputs[];
}

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
  const registry = new FakePersonaRegistry();
  if (opts.initialActive !== undefined) {
    registry.setActive(opts.initialActive);
  }
  const dispatcher = new PersonaReflexDispatcher({
    bus,
    time,
    registry,
    contextFactory: opts.contextFactory ?? spyFactory,
    logger,
    random: opts.random ?? (() => 0),
  });
  return { dispatcher, bus, time, registry, logger, contextFactoryCalls };
};

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
    yori: async () => {},
    signal: inputs.signal,
  };
};

// ─── tests ──────────────────────────────────────────────────────────

describe("PersonaReflexDispatcher", () => {
  describe("subscribeActive lifecycle", () => {
    it("constructs without active persona — no bus registrations", () => {
      const { bus } = createTestHarness();
      const handler = vi.fn();
      // dispatch with no active persona → no handler should fire.
      // ここでは spyOn ではなく、直接 dispatch して何も起きないことを assert
      bus.dispatch(makeUserEvent());
      expect(handler).not.toHaveBeenCalled();
    });

    it("setActive after construction registers customTriggers on bus", () => {
      const { bus, registry } = createTestHarness();
      const spy = vi.spyOn(bus, "register");
      const trigger = userInputTrigger("pleased");
      registry.setActive(makePersona({ customTriggers: [trigger] }));

      expect(spy).toHaveBeenCalledTimes(1);
      const [registeredTrigger, , source] = spy.mock.calls[0];
      expect(registeredTrigger).toBe(trigger);
      expect(source).toEqual({ type: "persona", packId: "alice" });
    });

    it("initialActive in test harness drives the first subscribeActive callback synchronously", () => {
      const handler = vi.fn<PersonaHandler>(async () => {});
      const persona = makePersona({
        customTriggers: [userInputTrigger("pleased")],
        responses: { pleased: { handlers: [{ handler }] } },
      });
      const { bus } = createTestHarness({ initialActive: persona });

      bus.dispatch(makeUserEvent());
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("active swap disposes old triggers and attaches new ones", () => {
      const { bus, registry } = createTestHarness();
      const aliceHandler = vi.fn<PersonaHandler>(async () => {});
      const bobHandler = vi.fn<PersonaHandler>(async () => {});
      const alice = makePersona({
        id: "alice",
        customTriggers: [userInputTrigger("pleased", "alice-t")],
        responses: { pleased: { handlers: [{ handler: aliceHandler }] } },
      });
      const bob = makePersona({
        id: "bob",
        customTriggers: [userInputTrigger("pleased", "bob-t")],
        responses: { pleased: { handlers: [{ handler: bobHandler }] } },
      });

      registry.setActive(alice);
      bus.dispatch(makeUserEvent());
      expect(aliceHandler).toHaveBeenCalledTimes(1);
      expect(bobHandler).not.toHaveBeenCalled();

      registry.setActive(bob);
      bus.dispatch(makeUserEvent());
      expect(aliceHandler).toHaveBeenCalledTimes(1); // 旧 trigger は dispose 済
      expect(bobHandler).toHaveBeenCalledTimes(1);
    });

    it("setActive(null) disposes triggers — no handler fires after", () => {
      const { bus, registry } = createTestHarness();
      const handler = vi.fn<PersonaHandler>(async () => {});
      registry.setActive(
        makePersona({
          customTriggers: [userInputTrigger("pleased")],
          responses: { pleased: { handlers: [{ handler }] } },
        }),
      );
      bus.dispatch(makeUserEvent());
      expect(handler).toHaveBeenCalledTimes(1);

      registry.setActive(null);
      bus.dispatch(makeUserEvent());
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("persona without reflex (minimal pack) registers nothing", () => {
      const { bus, registry } = createTestHarness();
      const spy = vi.spyOn(bus, "register");
      registry.setActive(makePersona({ noReflex: true }));
      expect(spy).not.toHaveBeenCalled();
    });

    it("persona with reflex but no customTriggers registers nothing", () => {
      const { bus, registry } = createTestHarness();
      const spy = vi.spyOn(bus, "register");
      registry.setActive(makePersona({ customTriggers: undefined }));
      expect(spy).not.toHaveBeenCalled();
    });

    it("dispose() removes bus registrations and stops listening to active swaps", () => {
      const { bus, registry, dispatcher } = createTestHarness();
      const handler = vi.fn<PersonaHandler>(async () => {});
      registry.setActive(
        makePersona({
          customTriggers: [userInputTrigger("pleased")],
          responses: { pleased: { handlers: [{ handler }] } },
        }),
      );
      dispatcher.dispose();

      bus.dispatch(makeUserEvent());
      expect(handler).not.toHaveBeenCalled();

      // dispose 後の active swap も無視される（listener 解除済）
      registry.setActive(
        makePersona({
          id: "bob",
          customTriggers: [userInputTrigger("pleased", "bob-t")],
          responses: { pleased: { handlers: [{ handler }] } },
        }),
      );
      bus.dispatch(makeUserEvent());
      expect(handler).not.toHaveBeenCalled();
    });

    it("active swap to same reference is a no-op (idempotent guard)", () => {
      const { bus, registry } = createTestHarness();
      const handler = vi.fn<PersonaHandler>(async () => {});
      const persona = makePersona({
        customTriggers: [userInputTrigger("pleased")],
        responses: { pleased: { handlers: [{ handler }] } },
      });
      const spy = vi.spyOn(bus, "register");

      registry.setActive(persona);
      registry.setActive(persona); // 同 reference

      // 1 回しか register されていない
      expect(spy).toHaveBeenCalledTimes(1);

      bus.dispatch(makeUserEvent());
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("bus wiring", () => {
    it("three custom triggers → three bus registrations with same source", () => {
      const { bus, registry } = createTestHarness();
      const spy = vi.spyOn(bus, "register");
      const triggers: Trigger[] = [
        userInputTrigger("pleased", "t1"),
        userInputTrigger("curious", "t2"),
        userInputTrigger("focused", "t3"),
      ];
      registry.setActive(makePersona({ customTriggers: triggers }));

      expect(spy).toHaveBeenCalledTimes(3);
      for (const call of spy.mock.calls) {
        const source = call[2] as PackSource;
        expect(source).toEqual({ type: "persona", packId: "alice" });
      }
    });
  });

  describe("responses lookup and execution", () => {
    it("single handler receives a PersonaContext whose event / persona match", () => {
      const { bus, registry } = createTestHarness();
      const handler = vi.fn<PersonaHandler>(async () => {});
      registry.setActive(
        makePersona({
          id: "alice",
          name: "Alice",
          customTriggers: [userInputTrigger("pleased")],
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
      const { bus, registry, logger } = createTestHarness();
      const handler = vi.fn<PersonaHandler>(async () => {});
      registry.setActive(
        makePersona({
          customTriggers: [userInputTrigger("pleased")],
          responses: { curious: { handlers: [{ handler }] } },
        }),
      );

      bus.dispatch(makeUserEvent());
      expect(handler).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("empty handler set → warn logged, nothing fires", () => {
      const { bus, registry, logger } = createTestHarness();
      registry.setActive(
        makePersona({
          customTriggers: [userInputTrigger("pleased")],
          responses: { pleased: { handlers: [] } },
        }),
      );

      bus.dispatch(makeUserEvent());
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("context has a live AbortSignal that is not aborted", () => {
      const { bus, registry } = createTestHarness();
      let seen: AbortSignal | undefined;
      const handler = vi.fn<PersonaHandler>(async (ctx) => {
        seen = ctx.signal;
      });
      registry.setActive(
        makePersona({
          customTriggers: [userInputTrigger("pleased")],
          responses: { pleased: { handlers: [{ handler }] } },
        }),
      );

      bus.dispatch(makeUserEvent());
      expect(seen).toBeDefined();
      expect(seen?.aborted).toBe(false);
    });

    it("active swap aborts the previous persona's AbortSignal", () => {
      const { bus, registry } = createTestHarness();
      let aliceSignal: AbortSignal | undefined;
      const aliceHandler = vi.fn<PersonaHandler>(async (ctx) => {
        aliceSignal = ctx.signal;
      });
      registry.setActive(
        makePersona({
          id: "alice",
          customTriggers: [userInputTrigger("pleased")],
          responses: { pleased: { handlers: [{ handler: aliceHandler }] } },
        }),
      );
      bus.dispatch(makeUserEvent());
      expect(aliceSignal?.aborted).toBe(false);

      registry.setActive(makePersona({ id: "bob" }));
      expect(aliceSignal?.aborted).toBe(true);
    });

    it("contextFactory receives inputs with event, persona, time, emitEvent", () => {
      const { bus, registry, time, contextFactoryCalls } = createTestHarness();
      const handler = vi.fn<PersonaHandler>(async () => {});
      registry.setActive(
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

    it("setContextFactory replaces the factory used for subsequent dispatches", () => {
      const { bus, registry, dispatcher } = createTestHarness();
      const handler = vi.fn<PersonaHandler>(async () => {});
      registry.setActive(
        makePersona({
          customTriggers: [userInputTrigger("pleased")],
          responses: { pleased: { handlers: [{ handler }] } },
        }),
      );

      const replacement: PersonaContextFactory = (inputs) => makeStubContext(inputs);
      const replacementSpy = vi.fn(replacement);
      dispatcher.setContextFactory(replacementSpy);

      bus.dispatch(makeUserEvent());
      expect(replacementSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("weighted selection", () => {
    it("single candidate is always selected", () => {
      const { bus, registry } = createTestHarness({ random: () => 0 });
      const a = vi.fn<PersonaHandler>(async () => {});
      const b = vi.fn<PersonaHandler>(async () => {});
      registry.setActive(
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
      const { bus, registry } = createTestHarness({ random: () => 0.3 });
      const a = vi.fn<PersonaHandler>(async () => {});
      const b = vi.fn<PersonaHandler>(async () => {});
      registry.setActive(
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
      const { bus, registry } = createTestHarness({ random: () => 0.7 });
      const a = vi.fn<PersonaHandler>(async () => {});
      const b = vi.fn<PersonaHandler>(async () => {});
      registry.setActive(
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
      const { bus, registry } = createTestHarness({ random: () => 0.5 });
      const a = vi.fn<PersonaHandler>(async () => {});
      const b = vi.fn<PersonaHandler>(async () => {});
      registry.setActive(
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
      const { bus, registry } = createTestHarness({ random: () => 0.9 });
      const a = vi.fn<PersonaHandler>(async () => {});
      const b = vi.fn<PersonaHandler>(async () => {});
      registry.setActive(
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
      const { bus, registry } = createTestHarness({ random: () => 0.1 });
      const a = vi.fn<PersonaHandler>(async () => {});
      const b = vi.fn<PersonaHandler>(async () => {});
      registry.setActive(
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
      const { bus, registry, logger } = createTestHarness({ random: () => 0.5 });
      const a = vi.fn<PersonaHandler>(async () => {});
      const b = vi.fn<PersonaHandler>(async () => {});
      registry.setActive(
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
    it("first fire at ts=1000 records lastFiredAt and second at 1500 with cooldownMs=1000 is blocked", () => {
      const { bus, registry, logger } = createTestHarness();
      const handler = vi.fn<PersonaHandler>(async () => {});
      registry.setActive(
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
      const { bus, registry } = createTestHarness();
      const handler = vi.fn<PersonaHandler>(async () => {});
      registry.setActive(
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
      const { bus, registry } = createTestHarness({ random: () => 0 });
      const a = vi.fn<PersonaHandler>(async () => {});
      const b = vi.fn<PersonaHandler>(async () => {});
      registry.setActive(
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

      bus.dispatch(makeUserEvent("one", 1000));
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).not.toHaveBeenCalled();

      bus.dispatch(makeUserEvent("two", 1500));
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it("all candidates in cooldown → warn, nothing fires", () => {
      const { bus, registry, logger } = createTestHarness({ random: () => 0 });
      const a = vi.fn<PersonaHandler>(async () => {});
      const b = vi.fn<PersonaHandler>(async () => {});
      registry.setActive(
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

      bus.dispatch(makeUserEvent("one", 1000));
      bus.dispatch(makeUserEvent("two", 1100));
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);

      logger.warn.mockClear();

      bus.dispatch(makeUserEvent("three", 1200));
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("active swap resets cooldown — new persona starts fresh even with same id", () => {
      const { bus, registry } = createTestHarness({ random: () => 0 });
      const handler = vi.fn<PersonaHandler>(async () => {});
      const persona1 = makePersona({
        id: "alice",
        customTriggers: [userInputTrigger("pleased")],
        responses: { pleased: { handlers: [{ handler, cooldownMs: 10_000 }] } },
      });
      // 同 id だが新 reference の persona
      const persona2 = makePersona({
        id: "alice",
        customTriggers: [userInputTrigger("pleased")],
        responses: { pleased: { handlers: [{ handler, cooldownMs: 10_000 }] } },
      });

      registry.setActive(persona1);
      bus.dispatch(makeUserEvent("one", 1000));
      expect(handler).toHaveBeenCalledTimes(1);

      // 500ms 後に同 id で reload → cooldown は新 instance なので fire できる
      registry.setActive(persona2);
      bus.dispatch(makeUserEvent("two", 1500));
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe("per-pack bound emitEvent", () => {
    it("ctx.emitEvent forwards to bus.emitSynthetic with persona source and correct depth", () => {
      const { bus, registry } = createTestHarness();
      const spy = vi.spyOn(bus, "emitSynthetic");
      const handler = vi.fn<PersonaHandler>(async (ctx) => {
        ctx.emitEvent("X", { hello: "world" });
      });
      registry.setActive(
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

    it("wrapper invoked at depth N propagates to ctx.emitEvent as parentDepth=N", () => {
      const { bus, registry } = createTestHarness();
      const spy = vi.spyOn(bus, "emitSynthetic");
      const handler = vi.fn<PersonaHandler>(async (ctx) => {
        ctx.emitEvent("bounce");
      });
      registry.setActive(
        makePersona({
          id: "alice",
          customTriggers: [syntheticTrigger("start", "pleased", "t-start")],
          responses: { pleased: { handlers: [{ handler }] } },
        }),
      );

      bus.emitSynthetic({ type: "persona", packId: "seed" }, "start", null, 1);
      const calls = spy.mock.calls.filter((c) => c[1] === "bounce");
      expect(calls).toHaveLength(1);
      const [, , , parentDepth] = calls[0];
      expect(parentDepth).toBe(2);
    });
  });

  describe("error isolation", () => {
    it("handler throws synchronously → error logged, dispatcher still functional", () => {
      const { bus, registry, logger } = createTestHarness();
      const bad = vi.fn<PersonaHandler>(() => {
        throw new Error("sync boom");
      });
      registry.setActive(
        makePersona({
          customTriggers: [userInputTrigger("pleased")],
          responses: { pleased: { handlers: [{ handler: bad }] } },
        }),
      );

      expect(() => bus.dispatch(makeUserEvent("a", 1000))).not.toThrow();
      expect(logger.error).toHaveBeenCalled();

      expect(() => bus.dispatch(makeUserEvent("b", 2000))).not.toThrow();
      expect(bad).toHaveBeenCalledTimes(2);
    });

    it("handler returns rejected promise → error logged, dispatcher still functional", async () => {
      const { bus, registry, logger } = createTestHarness();
      const bad = vi.fn<PersonaHandler>(() => Promise.reject(new Error("async boom")));
      registry.setActive(
        makePersona({
          customTriggers: [userInputTrigger("pleased")],
          responses: { pleased: { handlers: [{ handler: bad }] } },
        }),
      );

      bus.dispatch(makeUserEvent());
      await Promise.resolve();
      await Promise.resolve();
      expect(logger.error).toHaveBeenCalled();
    });
  });
});

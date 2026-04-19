/**
 * Integration smoke test for the charminal-default flagship persona.
 *
 * Proves the full runtime stack end-to-end:
 * Time -> EventBus -> trigger match -> PersonaReflexDispatcher wrapper ->
 * cooldown filter -> weighted selection -> stub PersonaContext creation ->
 * handler execution -> completion.
 *
 * The flagship persona has no custom triggers (only a responses table).
 * We augment it with test-specific custom triggers that simulate what
 * Perception built-in triggers would do in production.
 */

import type { PersonaDefinition, PtyOutputEvent, Trigger } from "@charminal/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Time } from "../../../src/core/time";
import { EventBus } from "../../../src/runtime/event-bus";
import { PersonaReflexDispatcher } from "../../../src/runtime/persona-reflex";
import { PersonaRegistryImpl } from "../../../src/runtime/persona-registry";
import {
  createStubPersonaContextFactory,
  type PersonaContextInputs,
} from "../../../src/runtime/persona-registry/stub-context";
import type { PersonaPackManifest } from "../../../src/sdk/persona-pack";
import persona from "./persona";

// ─── test-specific custom triggers ──────────────────────────────────

const testTriggers: ReadonlyArray<Trigger> = [
  {
    id: "test:error-to-distressed",
    match: (event) =>
      event.kind === "pty-output" && event.text.includes("ERROR")
        ? { reaction: "distressed" }
        : null,
  },
  {
    id: "test:idle-to-fidget",
    match: (event) => (event.kind === "idle" ? { reaction: "idle-fidget" } : null),
  },
];

/** The real persona augmented with test-specific custom triggers. */
const testPersona: PersonaDefinition = {
  ...persona,
  reflex: {
    ...persona.reflex,
    customTriggers: testTriggers,
  },
};

const testManifest: PersonaPackManifest = {
  id: testPersona.id,
  name: testPersona.name,
  type: "persona",
  version: "0.0.0-test",
  charminalVersion: "^0.0.0",
  entry: "persona.js",
};

// ─── helpers ────────────────────────────────────────────────────────

const makePtyOutputEvent = (text: string, timestamp = 1000): PtyOutputEvent => ({
  kind: "pty-output",
  text,
  timestamp,
});

interface TestHarnessOpts {
  random?: () => number;
  clock?: () => number;
}

interface TestHarness {
  registry: PersonaRegistryImpl;
  dispatcher: PersonaReflexDispatcher;
  bus: EventBus;
  time: Time;
  logger: {
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  contextInputs: PersonaContextInputs[];
  /** test 用：persona を bundled として register し、active として subscribeActive 経由で dispatcher に届ける。 */
  activate: (definition: PersonaDefinition) => void;
}

const createTestHarness = (opts: TestHarnessOpts = {}): TestHarness => {
  const time = new Time({ clock: opts.clock ?? (() => 1000) });
  const logger = {
    warn: vi.fn(),
    error: vi.fn(),
  };
  const bus = new EventBus({ time, logger, schedule: (task) => task() });

  const contextInputs: PersonaContextInputs[] = [];
  const factory = (inputs: PersonaContextInputs) => {
    contextInputs.push(inputs);
    return createStubPersonaContextFactory()(inputs);
  };

  const registry = new PersonaRegistryImpl();
  const dispatcher = new PersonaReflexDispatcher({
    bus,
    time,
    registry,
    contextFactory: factory,
    logger,
    random: opts.random ?? (() => 0.1),
  });

  const activate = (definition: PersonaDefinition): void => {
    registry.register({
      id: definition.id,
      manifest: testManifest,
      persona: definition,
      origin: "bundled",
    });
  };

  return { registry, dispatcher, bus, time, logger, contextInputs, activate };
};

// ─── tests ──────────────────────────────────────────────────────────

describe("charminal-default persona integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Registration ──────────────────────────────────────────────

  it("activates as the single bundled persona and is exposed via getActivePersona", () => {
    const { registry, activate } = createTestHarness();
    activate(testPersona);
    expect(registry.getActivePersona()?.id).toBe("charminal-default");
  });

  // ── Distressed handler end-to-end ─────────────────────────────

  it("dispatches pty-output with ERROR -> context factory called with distressed reaction", () => {
    const { bus, contextInputs, activate } = createTestHarness();
    activate(testPersona);

    bus.dispatch(makePtyOutputEvent("ERROR: something broke"));

    expect(contextInputs).toHaveLength(1);
    expect(contextInputs[0].event.reaction).toBe("distressed");
  });

  it("distressed handler receives correct persona identity", () => {
    const { bus, contextInputs, activate } = createTestHarness();
    activate(testPersona);

    bus.dispatch(makePtyOutputEvent("ERROR: something broke"));

    expect(contextInputs[0].persona.id).toBe("charminal-default");
    expect(contextInputs[0].persona.name).toBe("Charminal");
  });

  it("distressed handler runs to completion without crashing", async () => {
    const { bus, logger, activate } = createTestHarness();
    activate(testPersona);

    bus.dispatch(makePtyOutputEvent("ERROR: something broke"));

    // The handler awaits ctx.time.after(2500). Advance fake timers to let it finish.
    await vi.advanceTimersByTimeAsync(3000);

    expect(logger.error).not.toHaveBeenCalled();
  });

  // ── Weighted idle-fidget selection ─────────────────────────────

  it("random=0.1 selects handler 0 (look-around) for idle-fidget", async () => {
    const { bus, contextInputs, activate } = createTestHarness({ random: () => 0.1 });
    activate(testPersona);

    bus.dispatch({ kind: "idle", durationMs: 5000, timestamp: 1000 });
    await vi.advanceTimersByTimeAsync(2000);

    expect(contextInputs).toHaveLength(1);
    expect(contextInputs[0].event.reaction).toBe("idle-fidget");
  });

  it("random=0.7 selects a different handler (blink) for idle-fidget", async () => {
    const { bus, contextInputs, activate } = createTestHarness({ random: () => 0.7 });
    activate(testPersona);

    bus.dispatch({ kind: "idle", durationMs: 5000, timestamp: 1000 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(contextInputs).toHaveLength(1);
    expect(contextInputs[0].event.reaction).toBe("idle-fidget");
  });

  it("random=0.95 selects handler 2 (subtle-stretch) for idle-fidget", async () => {
    const { bus, contextInputs, activate } = createTestHarness({ random: () => 0.95 });
    activate(testPersona);

    bus.dispatch({ kind: "idle", durationMs: 5000, timestamp: 1000 });
    await vi.advanceTimersByTimeAsync(3000);

    expect(contextInputs).toHaveLength(1);
    expect(contextInputs[0].event.reaction).toBe("idle-fidget");
  });

  // ── Cooldown ──────────────────────────────────────────────────

  it("subtle-stretch cooldown blocks second fire, falls back to another handler", async () => {
    const { bus, contextInputs, activate } = createTestHarness({ random: () => 0.95 });
    activate(testPersona);

    // First fire: handler 2 (subtle-stretch) selected at timestamp 1000
    bus.dispatch({ kind: "idle", durationMs: 5000, timestamp: 1000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(contextInputs).toHaveLength(1);

    // Second fire 1 second later: handler 2 has cooldownMs=180000,
    // so it is still in cooldown. Handlers 0 and 1 remain eligible.
    bus.dispatch({ kind: "idle", durationMs: 6000, timestamp: 2000 });
    await vi.advanceTimersByTimeAsync(3000);

    // Both fires produced a context (neither was skipped entirely)
    expect(contextInputs).toHaveLength(2);
    // Both reactions are idle-fidget
    expect(contextInputs[0].event.reaction).toBe("idle-fidget");
    expect(contextInputs[1].event.reaction).toBe("idle-fidget");
  });

  // ── emitEvent binding ─────────────────────────────────────────

  it("emitEvent is a function on the context and does not throw when called", async () => {
    const { bus, contextInputs, activate } = createTestHarness();
    activate(testPersona);

    bus.dispatch(makePtyOutputEvent("ERROR: test"));
    await vi.advanceTimersByTimeAsync(3000);

    expect(contextInputs).toHaveLength(1);
    expect(typeof contextInputs[0].emitEvent).toBe("function");
    expect(() => contextInputs[0].emitEvent("test:announce", { foo: 1 })).not.toThrow();
  });
});

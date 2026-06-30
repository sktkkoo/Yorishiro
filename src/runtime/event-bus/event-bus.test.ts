import type { ReactionType, SyntheticEvent, Trigger, UserInputEvent } from "@charminal/sdk";
import { describe, expect, it, vi } from "vitest";
import { Time } from "../../core/time";
import {
  EventBus,
  type EventBusDeps,
  type EventBusLogger,
  type PackSource,
  type ReactionHandler,
} from "./event-bus";

// ─── helpers ────────────────────────────────────────────────────────

/** A trigger that always matches with the given reaction. */
const alwaysMatch = (reaction: ReactionType, id = "t"): Trigger => ({
  id,
  match: () => ({ reaction }),
});

/** A trigger that never matches. */
const neverMatch = (id = "t-never"): Trigger => ({
  id,
  match: () => null,
});

/** A trigger that matches only synthetic events with a specific name. */
const syntheticMatch = (
  targetName: string,
  reaction: ReactionType = "curious",
  id = "t-synthetic",
): Trigger => ({
  id,
  match: (event) => {
    if (event.kind === "synthetic" && event.name === targetName) {
      return { reaction, payload: event.payload };
    }
    return null;
  },
});

const makeUserEvent = (text = "hello"): UserInputEvent => ({
  kind: "user-input",
  text,
  timestamp: 1000,
});

const makePersonaSource = (packId = "alice"): PackSource => ({
  type: "persona",
  packId,
});

interface TestBusOpts {
  clock?: () => number;
  maxDepth?: number;
  /** If true, use the default queueMicrotask scheduler instead of the sync override. */
  async?: boolean;
}

interface TestBusHandle {
  bus: EventBus;
  time: Time;
  logger: EventBusLogger & {
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

const createTestBus = (opts: TestBusOpts = {}): TestBusHandle => {
  const time = new Time({ clock: opts.clock ?? (() => 1000) });
  const logger = {
    warn: vi.fn<(message: string, meta?: Record<string, unknown>) => void>(),
    error: vi.fn<(message: string, meta?: Record<string, unknown>) => void>(),
  };
  const deps: EventBusDeps = {
    time,
    logger,
    ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
    ...(opts.async ? {} : { schedule: (task: () => void) => task() }),
  };
  const bus = new EventBus(deps);
  return { bus, time, logger };
};

// ─── tests ──────────────────────────────────────────────────────────

describe("EventBus", () => {
  describe("construction and registration", () => {
    it("accepts just a Time instance with defaults for logger, scheduler, maxDepth", () => {
      const time = new Time({ clock: () => 0 });
      expect(() => new EventBus({ time })).not.toThrow();
    });

    it("register() returns a Registration whose dispose removes the entry", () => {
      const { bus } = createTestBus();
      const handler = vi.fn<ReactionHandler>();
      const reg = bus.register(alwaysMatch("pleased"), handler, makePersonaSource());

      reg.dispose();
      bus.dispatch(makeUserEvent());
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("external dispatch", () => {
    it("notifies dispatch subscribers before trigger handling", () => {
      const { bus } = createTestBus();
      const order: string[] = [];
      const listener = vi.fn(() => order.push("listener"));
      const handler = vi.fn<ReactionHandler>(() => {
        order.push("handler");
      });
      bus.subscribeDispatch(listener);
      bus.register(alwaysMatch("pleased"), handler, makePersonaSource());

      const event = makeUserEvent("hi");
      bus.dispatch(event);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(event);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["listener", "handler"]);
    });

    it("stops notifying a dispatch subscriber after disposal", () => {
      const { bus } = createTestBus();
      const listener = vi.fn();
      const subscription = bus.subscribeDispatch(listener);

      subscription.dispose();
      bus.dispatch(makeUserEvent("hi"));

      expect(listener).not.toHaveBeenCalled();
    });

    it("logs dispatch subscriber errors without blocking handlers", () => {
      const { bus, logger } = createTestBus();
      const handler = vi.fn<ReactionHandler>();
      bus.subscribeDispatch(() => {
        throw new Error("listener failed");
      });
      bus.register(alwaysMatch("pleased"), handler, makePersonaSource());

      bus.dispatch(makeUserEvent("hi"));

      expect(logger.error).toHaveBeenCalledWith(
        "EventBus: dispatch listener threw",
        expect.objectContaining({ eventKind: "user-input", error: "listener failed" }),
      );
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("calls the handler when a trigger matches, passing a ReactionEvent", () => {
      const { bus } = createTestBus();
      const handler = vi.fn<ReactionHandler>();
      const trigger = alwaysMatch("pleased", "trig-1");
      bus.register(trigger, handler, makePersonaSource());

      const event = makeUserEvent("hi");
      bus.dispatch(event);

      expect(handler).toHaveBeenCalledTimes(1);
      const [reactionEvent] = handler.mock.calls[0];
      expect(reactionEvent.reaction).toBe("pleased");
      expect(reactionEvent.triggeredBy).toBe(event);
      expect(reactionEvent.trigger).toBe(trigger);
    });

    it("does NOT call the handler when the trigger returns null", () => {
      const { bus } = createTestBus();
      const handler = vi.fn<ReactionHandler>();
      bus.register(neverMatch(), handler, makePersonaSource());

      bus.dispatch(makeUserEvent());
      expect(handler).not.toHaveBeenCalled();
    });

    it("calls all matching handlers when multiple triggers match", () => {
      const { bus } = createTestBus();
      const a = vi.fn<ReactionHandler>();
      const b = vi.fn<ReactionHandler>();
      bus.register(alwaysMatch("pleased", "a"), a, makePersonaSource("alice"));
      bus.register(alwaysMatch("curious", "b"), b, makePersonaSource("bob"));

      bus.dispatch(makeUserEvent());

      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it("schedules higher-priority triggers before lower-priority ones", () => {
      const { bus } = createTestBus();
      const order: string[] = [];
      const high = vi.fn<ReactionHandler>(() => {
        order.push("high");
      });
      const low = vi.fn<ReactionHandler>(() => {
        order.push("low");
      });

      // Register low first to prove priority overrides registration order.
      bus.register(
        { id: "low", priority: 1, match: () => ({ reaction: "pleased" }) },
        low,
        makePersonaSource("low-pack"),
      );
      bus.register(
        { id: "high", priority: 10, match: () => ({ reaction: "pleased" }) },
        high,
        makePersonaSource("high-pack"),
      );

      bus.dispatch(makeUserEvent());
      expect(order).toEqual(["high", "low"]);
    });

    it("treats missing priority as 0", () => {
      const { bus } = createTestBus();
      const order: string[] = [];
      const unprioritized = vi.fn<ReactionHandler>(() => {
        order.push("unprioritized");
      });
      const prioritized = vi.fn<ReactionHandler>(() => {
        order.push("prioritized");
      });

      bus.register(
        { id: "u", match: () => ({ reaction: "pleased" }) },
        unprioritized,
        makePersonaSource("u"),
      );
      bus.register(
        { id: "p", priority: 1, match: () => ({ reaction: "pleased" }) },
        prioritized,
        makePersonaSource("p"),
      );

      bus.dispatch(makeUserEvent());
      expect(order).toEqual(["prioritized", "unprioritized"]);
    });

    it("preserves registration order within equal priority (stable sort)", () => {
      const { bus } = createTestBus();
      const order: string[] = [];
      const first = vi.fn<ReactionHandler>(() => {
        order.push("first");
      });
      const second = vi.fn<ReactionHandler>(() => {
        order.push("second");
      });

      bus.register(alwaysMatch("pleased", "first"), first, makePersonaSource("a"));
      bus.register(alwaysMatch("pleased", "second"), second, makePersonaSource("b"));

      bus.dispatch(makeUserEvent());
      expect(order).toEqual(["first", "second"]);
    });

    it("schedules handlers asynchronously by default (queueMicrotask)", async () => {
      // Use the async default scheduler — no override.
      const { bus } = createTestBus({ async: true });
      const handler = vi.fn<ReactionHandler>();
      bus.register(alwaysMatch("pleased"), handler, makePersonaSource());

      bus.dispatch(makeUserEvent());
      // Not yet — microtask hasn't run.
      expect(handler).not.toHaveBeenCalled();

      await Promise.resolve();
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("runs handler synchronously when a sync scheduler override is passed", () => {
      const { bus } = createTestBus(); // sync by default in test helper
      const handler = vi.fn<ReactionHandler>();
      bus.register(alwaysMatch("pleased"), handler, makePersonaSource());

      bus.dispatch(makeUserEvent());
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("logs and does not throw when a handler throws synchronously", () => {
      const { bus, logger } = createTestBus();
      const boom = vi.fn<ReactionHandler>(() => {
        throw new Error("boom");
      });
      bus.register(alwaysMatch("pleased"), boom, makePersonaSource());

      expect(() => bus.dispatch(makeUserEvent())).not.toThrow();
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it("logs and does not throw when a handler returns a rejected promise", async () => {
      const { bus, logger } = createTestBus();
      const boom = vi.fn<ReactionHandler>(() => Promise.reject(new Error("async boom")));
      bus.register(alwaysMatch("pleased"), boom, makePersonaSource());

      expect(() => bus.dispatch(makeUserEvent())).not.toThrow();
      // give the .catch handler a tick to run
      await Promise.resolve();
      await Promise.resolve();
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it("invokes the handler with depth = 1 for external dispatch", () => {
      const { bus } = createTestBus();
      const handler = vi.fn<ReactionHandler>();
      bus.register(alwaysMatch("pleased"), handler, makePersonaSource());

      bus.dispatch(makeUserEvent());
      expect(handler).toHaveBeenCalledTimes(1);
      const [, depth] = handler.mock.calls[0];
      expect(depth).toBe(1);
    });
  });

  describe("synthetic dispatch", () => {
    it("delivers a ReactionEvent whose triggeredBy is the SyntheticEvent", () => {
      const { bus } = createTestBus();
      const handler = vi.fn<ReactionHandler>();
      const source = makePersonaSource("alice");
      bus.register(syntheticMatch("deploy-failed", "distressed"), handler, source);

      bus.emitSynthetic(source, "deploy-failed", { exitCode: 1 }, 1);

      expect(handler).toHaveBeenCalledTimes(1);
      const [reactionEvent] = handler.mock.calls[0];
      expect(reactionEvent.triggeredBy.kind).toBe("synthetic");
      const synthetic = reactionEvent.triggeredBy as SyntheticEvent;
      expect(synthetic.name).toBe("deploy-failed");
      expect(synthetic.payload).toEqual({ exitCode: 1 });
    });

    it("auto-fills the synthetic event's timestamp from time.now()", () => {
      const { bus } = createTestBus({ clock: () => 12345 });
      const handler = vi.fn<ReactionHandler>();
      const source = makePersonaSource();
      bus.register(syntheticMatch("ping"), handler, source);

      bus.emitSynthetic(source, "ping", null, 1);

      const [reactionEvent] = handler.mock.calls[0];
      const synthetic = reactionEvent.triggeredBy as SyntheticEvent;
      expect(synthetic.timestamp).toBe(12345);
    });

    it("stamps the provided source verbatim onto the synthetic event", () => {
      const { bus } = createTestBus();
      const handler = vi.fn<ReactionHandler>();
      const emitSource: PackSource = { type: "persona", packId: "alice" };
      // Register on a different source so we can observe the emit source wins.
      bus.register(syntheticMatch("note"), handler, { type: "system", packId: "utility-x" });

      bus.emitSynthetic(emitSource, "note", undefined, 1);

      const [reactionEvent] = handler.mock.calls[0];
      const synthetic = reactionEvent.triggeredBy as SyntheticEvent;
      expect(synthetic.source).toEqual({ type: "persona", packId: "alice" });
    });

    it("invokes the handler with depth = parentDepth + 1", () => {
      const { bus } = createTestBus();
      const handler = vi.fn<ReactionHandler>();
      const source = makePersonaSource();
      bus.register(syntheticMatch("step"), handler, source);

      bus.emitSynthetic(source, "step", null, 2);

      expect(handler).toHaveBeenCalledTimes(1);
      const [, depth] = handler.mock.calls[0];
      expect(depth).toBe(3);
    });

    it("silently drops and warns when parentDepth + 1 exceeds default maxDepth (4)", () => {
      const { bus, logger } = createTestBus();
      const handler = vi.fn<ReactionHandler>();
      const source = makePersonaSource();
      bus.register(syntheticMatch("overflow"), handler, source);

      expect(() => bus.emitSynthetic(source, "overflow", null, 4)).not.toThrow();

      expect(handler).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [, meta] = logger.warn.mock.calls[0];
      expect(meta).toMatchObject({
        name: "overflow",
        parentDepth: 4,
        source: { type: "persona", packId: "alice" },
      });
    });

    it("respects an overridden maxDepth", () => {
      const { bus, logger } = createTestBus({ maxDepth: 2 });
      const handler = vi.fn<ReactionHandler>();
      const source = makePersonaSource();
      bus.register(syntheticMatch("overflow"), handler, source);

      bus.emitSynthetic(source, "overflow", null, 2);
      expect(handler).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("allows synthetic events exactly at the max depth", () => {
      const { bus, logger } = createTestBus();
      const handler = vi.fn<ReactionHandler>();
      const source = makePersonaSource();
      bus.register(syntheticMatch("edge"), handler, source);

      bus.emitSynthetic(source, "edge", null, 3);

      expect(handler).toHaveBeenCalledTimes(1);
      const [, depth] = handler.mock.calls[0];
      expect(depth).toBe(4);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe("disposal edge cases", () => {
    it("dispose then dispatch is a no-op, and a second dispose does not throw", () => {
      const { bus } = createTestBus();
      const handler = vi.fn<ReactionHandler>();
      const reg = bus.register(alwaysMatch("pleased"), handler, makePersonaSource());

      reg.dispose();
      expect(() => reg.dispose()).not.toThrow();

      bus.dispatch(makeUserEvent());
      expect(handler).not.toHaveBeenCalled();
    });
  });
});

import type { DispatchEvent } from "@charminal/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../../runtime/event-bus";
import { Time } from "../time";
import { Perception, type PerceptionDeps } from "./perception";

// ─── helpers ────────────────────────────────────────────────────

let clockMs: number;
const clock = () => clockMs;

const createStack = (overrides?: Partial<PerceptionDeps>) => {
  clockMs = 1000;
  const dispatched: DispatchEvent[] = [];

  const time = new Time({ clock, random: () => 0.5 });
  const bus = new EventBus({
    time,
    schedule: (task) => task(), // synchronous for test
  });

  // Intercept dispatches by registering a catch-all trigger
  bus.register(
    {
      id: "test-spy",
      match: (event) => ({ reaction: `spy:${event.kind}` }),
    },
    (reactionEvent) => {
      dispatched.push(reactionEvent.triggeredBy);
    },
    { type: "persona", packId: "test" },
  );

  const perception = new Perception({
    bus,
    time,
    idleThresholdMs: 5000,
    idleCheckIntervalMs: 1000,
    ...overrides,
  });

  return { time, bus, perception, dispatched };
};

// ─── tests ──────────────────────────────────────────────────────

describe("Perception", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── PTY output ──────────────────────────────────────────────

  describe("onPtyOutput", () => {
    it("coalesces PtyOutputEvent text within one frame budget", () => {
      const { perception, dispatched } = createStack();
      clockMs = 2000;

      perception.onPtyOutput("hello ");
      clockMs = 2004;
      perception.onPtyOutput("world");

      expect(dispatched).toHaveLength(0);

      vi.advanceTimersByTime(16);

      expect(dispatched).toHaveLength(1);
      const event = dispatched[0];
      expect(event.kind).toBe("pty-output");
      if (event.kind === "pty-output") {
        expect(event.text).toBe("hello world");
        expect(event.timestamp).toBe(2000);
      }
    });

    it("does not dispatch after dispose", () => {
      const { perception, dispatched } = createStack();
      perception.dispose();

      perception.onPtyOutput("should be ignored");
      vi.advanceTimersByTime(16);

      expect(dispatched).toHaveLength(0);
    });

    it("drops pending PTY output on dispose", () => {
      const { perception, dispatched } = createStack();

      perception.onPtyOutput("pending");
      perception.dispose();
      vi.advanceTimersByTime(16);

      expect(dispatched).toHaveLength(0);
    });
  });

  // ── Command block ─────────────────────────────────────────

  describe("onCommandBlock", () => {
    it("dispatches CommandBlockEvent with host-stamped session id", () => {
      const { perception, dispatched } = createStack();
      clockMs = 2500;

      perception.onCommandBlock({
        command: "npm test",
        exitCode: 1,
        durationMs: 1200,
        sessionId: "shell-1",
      });

      expect(dispatched).toHaveLength(1);
      const event = dispatched[0];
      expect(event.kind).toBe("command-block");
      if (event.kind === "command-block") {
        expect(event.command).toBe("npm test");
        expect(event.exitCode).toBe(1);
        expect(event.durationMs).toBe(1200);
        expect(event.sessionId).toBe("shell-1");
        expect(event.timestamp).toBe(2500);
      }
    });

    it("does not dispatch after dispose", () => {
      const { perception, dispatched } = createStack();
      perception.dispose();

      perception.onCommandBlock({
        command: "npm test",
        exitCode: 0,
        durationMs: 100,
        sessionId: "shell-1",
      });

      expect(dispatched).toHaveLength(0);
    });
  });

  // ── Hook signals ────────────────────────────────────────────

  describe("onHookSignal", () => {
    it("maps prompt to user-prompt-submit", () => {
      const { perception, dispatched } = createStack();
      clockMs = 3000;

      perception.onHookSignal('{"event":"prompt"}');

      expect(dispatched).toHaveLength(1);
      const event = dispatched[0];
      expect(event.kind).toBe("hook-signal");
      if (event.kind === "hook-signal") {
        expect(event.signal.name).toBe("user-prompt-submit");
        expect(event.timestamp).toBe(3000);
      }
    });

    it("maps pre-tool-use and emits ToolActivityEvent", () => {
      const { perception, dispatched } = createStack();

      perception.onHookSignal('{"event":"pre-tool-use","tool_name":"Read"}');

      // HookSignalEvent + ToolActivityEvent
      expect(dispatched).toHaveLength(2);
      expect(dispatched[0].kind).toBe("hook-signal");
      expect(dispatched[1].kind).toBe("tool-activity");
      if (dispatched[1].kind === "tool-activity") {
        expect(dispatched[1].activity).toBe("reading");
      }
    });

    it("preserves post-tool-failure as a distinct signal with error payload", () => {
      const { perception, dispatched } = createStack();

      perception.onHookSignal('{"event":"post-tool-failure","tool_name":"Bash","error":"exit 1"}');

      expect(dispatched).toHaveLength(1);
      const event = dispatched[0];
      if (event.kind === "hook-signal") {
        expect(event.signal.name).toBe("post-tool-failure");
        expect((event.signal.payload as Record<string, unknown>).error).toBe("exit 1");
      }
    });

    it("maps stop and emits ToolActivityEvent none", () => {
      const { perception, dispatched } = createStack();

      perception.onHookSignal('{"event":"stop"}');

      expect(dispatched).toHaveLength(2);
      expect(dispatched[0].kind).toBe("hook-signal");
      if (dispatched[0].kind === "hook-signal") {
        expect(dispatched[0].signal.name).toBe("stop");
      }
      expect(dispatched[1].kind).toBe("tool-activity");
      if (dispatched[1].kind === "tool-activity") {
        expect(dispatched[1].activity).toBe("none");
      }
    });

    it("maps additional official hook events without deriving loop lifecycle", () => {
      const { perception, dispatched } = createStack();

      perception.onHookSignal('{"event":"permission-request","tool_name":"Bash"}');
      perception.onHookSignal('{"event":"permission-denied","tool_name":"Bash"}');
      perception.onHookSignal('{"event":"task-completed"}');
      perception.onHookSignal('{"event":"stop-failure","error":"rate_limit"}');
      perception.onHookSignal('{"event":"pre-compact"}');
      perception.onHookSignal('{"event":"post-compact"}');
      perception.onHookSignal('{"event":"session-end"}');

      expect(dispatched.map((event) => event.kind)).toEqual([
        "hook-signal",
        "hook-signal",
        "hook-signal",
        "hook-signal",
        "hook-signal",
        "hook-signal",
        "hook-signal",
      ]);
      expect(
        dispatched.map((event) => (event.kind === "hook-signal" ? event.signal.name : null)),
      ).toEqual([
        "permission-request",
        "permission-denied",
        "task-completed",
        "stop-failure",
        "pre-compact",
        "post-compact",
        "session-end",
      ]);
    });

    it("ignores malformed JSON", () => {
      const { perception, dispatched } = createStack();

      perception.onHookSignal("not json");

      expect(dispatched).toHaveLength(0);
    });

    it("ignores unknown event types", () => {
      const { perception, dispatched } = createStack();

      perception.onHookSignal('{"event":"unknown-event"}');

      expect(dispatched).toHaveLength(0);
    });

    it("ignores JSON without event field", () => {
      const { perception, dispatched } = createStack();

      perception.onHookSignal('{"foo":"bar"}');

      expect(dispatched).toHaveLength(0);
    });
  });

  // ── Tool activity inference ─────────────────────────────────

  describe("tool activity inference", () => {
    it("Write → writing", () => {
      const { perception, dispatched } = createStack();

      perception.onHookSignal('{"event":"pre-tool-use","tool_name":"Write"}');

      const toolEvent = dispatched.find((e) => e.kind === "tool-activity");
      if (toolEvent?.kind === "tool-activity") {
        expect(toolEvent.activity).toBe("writing");
      }
    });

    it("Edit → writing", () => {
      const { perception, dispatched } = createStack();

      perception.onHookSignal('{"event":"pre-tool-use","tool_name":"Edit"}');

      const toolEvent = dispatched.find((e) => e.kind === "tool-activity");
      if (toolEvent?.kind === "tool-activity") {
        expect(toolEvent.activity).toBe("writing");
      }
    });

    it("Bash → running", () => {
      const { perception, dispatched } = createStack();

      perception.onHookSignal('{"event":"pre-tool-use","tool_name":"Bash"}');

      const toolEvent = dispatched.find((e) => e.kind === "tool-activity");
      if (toolEvent?.kind === "tool-activity") {
        expect(toolEvent.activity).toBe("running");
      }
    });

    it("Glob → reading", () => {
      const { perception, dispatched } = createStack();

      perception.onHookSignal('{"event":"pre-tool-use","tool_name":"Glob"}');

      const toolEvent = dispatched.find((e) => e.kind === "tool-activity");
      if (toolEvent?.kind === "tool-activity") {
        expect(toolEvent.activity).toBe("reading");
      }
    });

    it("unknown tool → reading (fallback)", () => {
      const { perception, dispatched } = createStack();

      perception.onHookSignal('{"event":"pre-tool-use","tool_name":"SomeUnknownTool"}');

      const toolEvent = dispatched.find((e) => e.kind === "tool-activity");
      if (toolEvent?.kind === "tool-activity") {
        expect(toolEvent.activity).toBe("reading");
      }
    });
  });

  // ── User input ──────────────────────────────────────────────

  describe("onUserInput", () => {
    it("dispatches UserInputEvent", () => {
      const { perception, dispatched } = createStack();
      clockMs = 4000;

      perception.onUserInput("ls\n");

      expect(dispatched).toHaveLength(1);
      const event = dispatched[0];
      expect(event.kind).toBe("user-input");
      if (event.kind === "user-input") {
        expect(event.text).toBe("ls\n");
        expect(event.timestamp).toBe(4000);
      }
    });
  });

  // ── Idle detection ──────────────────────────────────────────

  describe("idle detection", () => {
    it("dispatches IdleEvent after threshold", () => {
      const { dispatched } = createStack();
      dispatched.length = 0;

      // Advance past idle threshold (5000ms) + one check interval (1000ms)
      clockMs = 7000;
      vi.advanceTimersByTime(1000);

      const idleEvents = dispatched.filter((e) => e.kind === "idle");
      expect(idleEvents).toHaveLength(1);
      if (idleEvents[0].kind === "idle") {
        expect(idleEvents[0].durationMs).toBe(6000); // 7000 - 1000
        expect(idleEvents[0].timestamp).toBe(7000);
      }
    });

    it("resets idle timer on PTY output", () => {
      const { perception, dispatched } = createStack();
      dispatched.length = 0;

      // Activity at 3000ms
      clockMs = 3000;
      perception.onPtyOutput("data");
      dispatched.length = 0;

      // Check at 4000ms: only 1s since activity → no idle
      clockMs = 4000;
      vi.advanceTimersByTime(1000);

      const idleEvents = dispatched.filter((e) => e.kind === "idle");
      expect(idleEvents).toHaveLength(0);
    });

    it("fires repeatedly while idle with increasing durationMs", () => {
      const { dispatched } = createStack();
      dispatched.length = 0;

      // First check at 6s: idle for 5s → fires
      clockMs = 6000;
      vi.advanceTimersByTime(1000);
      // Second check at 7s: idle for 6s → fires again
      clockMs = 7000;
      vi.advanceTimersByTime(1000);

      const idleEvents = dispatched.filter((e) => e.kind === "idle");
      expect(idleEvents).toHaveLength(2);
      if (idleEvents[0].kind === "idle" && idleEvents[1].kind === "idle") {
        expect(idleEvents[0].durationMs).toBe(5000);
        expect(idleEvents[1].durationMs).toBe(6000);
      }
    });

    it("stops idle checks after dispose", () => {
      const { perception, dispatched } = createStack();
      dispatched.length = 0;

      perception.dispose();

      clockMs = 100_000;
      vi.advanceTimersByTime(10_000);

      const idleEvents = dispatched.filter((e) => e.kind === "idle");
      expect(idleEvents).toHaveLength(0);
    });
  });

  // ── Presence restore ─────────────────────────────────

  describe("Presence restore", () => {
    it("user-prompt-submit で onPresenceRestore が呼ばれる", () => {
      const onPresenceRestore = vi.fn();
      const { perception } = createStack({
        onPresenceRestore,
      });

      perception.onHookSignal('{"event":"prompt"}');

      expect(onPresenceRestore).toHaveBeenCalledTimes(1);
    });
  });

  // ── Loop lifecycle ──────────────────────────────────────────

  describe("ingestLoopLifecycle", () => {
    it("dispatches LoopLifecycleEvent with phase, agent, detail, timestamp", () => {
      const { perception, dispatched } = createStack();
      clockMs = 5000;

      perception.ingestLoopLifecycle("blocked-on-approval", "codex", {
        runId: "r1",
        reason: "destructive op",
      });

      expect(dispatched).toHaveLength(1);
      const event = dispatched[0];
      expect(event.kind).toBe("loop-lifecycle");
      if (event.kind === "loop-lifecycle") {
        expect(event.phase).toBe("blocked-on-approval");
        expect(event.agent).toBe("codex");
        expect(event.detail).toEqual({ runId: "r1", reason: "destructive op" });
        expect(event.timestamp).toBe(5000);
      }
    });

    it("agent null for pack-origin announce, detail optional", () => {
      const { perception, dispatched } = createStack();

      perception.ingestLoopLifecycle("started", null);

      expect(dispatched).toHaveLength(1);
      const event = dispatched[0];
      if (event.kind === "loop-lifecycle") {
        expect(event.agent).toBeNull();
        expect(event.detail).toBeUndefined();
      }
    });

    it("does not dispatch after dispose", () => {
      const { perception, dispatched } = createStack();
      perception.dispose();

      perception.ingestLoopLifecycle("iterating", "claude");

      expect(dispatched).toHaveLength(0);
    });

    it("does not count as user activity (idle still fires after a loop event)", () => {
      const { perception, dispatched } = createStack();
      dispatched.length = 0;

      // loop event at 4000ms — must NOT reset the user-idle clock (away mode).
      clockMs = 4000;
      perception.ingestLoopLifecycle("iterating", "claude");
      dispatched.length = 0;

      // check at 6000ms: 5000ms since last *user* activity (1000) → idle fires.
      clockMs = 6000;
      vi.advanceTimersByTime(1000);

      const idleEvents = dispatched.filter((e) => e.kind === "idle");
      expect(idleEvents).toHaveLength(1);
      if (idleEvents[0]?.kind === "idle") {
        expect(idleEvents[0].durationMs).toBe(5000); // 6000 - 1000, not 6000 - 4000
      }
    });
  });
});

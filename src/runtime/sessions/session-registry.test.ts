/**
 * SessionRegistry の lifecycle / event dispatch を固める test。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { _clearForTest } from "../hot-data/hot-data";
import { getSessionRegistry, SessionRegistry } from "./session-registry";
import type { SessionDescriptor, SessionEvent } from "./types";

const makeDescriptor = (
  id: string,
  overrides: Partial<SessionDescriptor> = {},
): SessionDescriptor => ({
  id,
  profileId: "shell",
  kind: "shell",
  label: id,
  cwd: null,
  displayCwd: null,
  startedAt: 0,
  ...overrides,
});

beforeEach(() => {
  _clearForTest();
});

describe("SessionRegistry — lifecycle", () => {
  it("add() registers a descriptor and list() returns it", () => {
    const reg = new SessionRegistry();
    const desc = makeDescriptor("a");
    reg.add(desc);
    expect(reg.list()).toEqual([desc]);
    expect(reg.get("a")).toEqual(desc);
  });

  it("add() with existing id is a no-op", () => {
    const reg = new SessionRegistry();
    reg.add(makeDescriptor("a", { label: "first" }));
    reg.add(makeDescriptor("a", { label: "second" }));
    expect(reg.get("a")?.label).toBe("first");
  });

  it("remove() returns true for known id and false for unknown", () => {
    const reg = new SessionRegistry();
    reg.add(makeDescriptor("a"));
    expect(reg.remove("a")).toBe(true);
    expect(reg.remove("a")).toBe(false);
    expect(reg.get("a")).toBeNull();
  });

  it("list() preserves insertion order", () => {
    const reg = new SessionRegistry();
    reg.add(makeDescriptor("a"));
    reg.add(makeDescriptor("b"));
    reg.add(makeDescriptor("c"));
    expect(reg.list().map((d) => d.id)).toEqual(["a", "b", "c"]);
  });

  it("get() returns null for unknown id", () => {
    const reg = new SessionRegistry();
    expect(reg.get("phantom")).toBeNull();
  });
});

describe("SessionRegistry — lifecycle / activity state", () => {
  it("add() initializes lifecycle to 'starting' and activity to 'idle'", () => {
    const reg = new SessionRegistry();
    reg.add(makeDescriptor("a"));
    expect(reg.getLifecycle("a")).toBe("starting");
    expect(reg.getActivity("a")).toBe("idle");
  });

  it("setLifecycle() updates the value", () => {
    const reg = new SessionRegistry();
    reg.add(makeDescriptor("a"));
    reg.setLifecycle("a", "running");
    expect(reg.getLifecycle("a")).toBe("running");
  });

  it("setLifecycle() on unknown id is a no-op", () => {
    const reg = new SessionRegistry();
    reg.setLifecycle("phantom", "running");
    expect(reg.getLifecycle("phantom")).toBeNull();
  });

  it("setActivity() updates the value", () => {
    const reg = new SessionRegistry();
    reg.add(makeDescriptor("a"));
    reg.setActivity("a", "running-command");
    expect(reg.getActivity("a")).toBe("running-command");
  });
});

describe("SessionRegistry — events", () => {
  it("add() emits session-added with the descriptor", () => {
    const reg = new SessionRegistry();
    const events: SessionEvent[] = [];
    reg.on((e) => events.push(e));
    const desc = makeDescriptor("a");
    reg.add(desc);
    expect(events).toEqual([{ type: "session-added", descriptor: desc }]);
  });

  it("remove() emits session-removed", () => {
    const reg = new SessionRegistry();
    reg.add(makeDescriptor("a"));
    const events: SessionEvent[] = [];
    reg.on((e) => events.push(e));
    reg.remove("a");
    expect(events).toEqual([{ type: "session-removed", id: "a" }]);
  });

  it("setLifecycle() emits session-lifecycle-changed when value changes", () => {
    const reg = new SessionRegistry();
    reg.add(makeDescriptor("a"));
    const events: SessionEvent[] = [];
    reg.on((e) => events.push(e));
    reg.setLifecycle("a", "running");
    expect(events).toEqual([{ type: "session-lifecycle-changed", id: "a", lifecycle: "running" }]);
  });

  it("setLifecycle() with same value is a no-op (no event)", () => {
    const reg = new SessionRegistry();
    reg.add(makeDescriptor("a"));
    reg.setLifecycle("a", "running");
    const events: SessionEvent[] = [];
    reg.on((e) => events.push(e));
    reg.setLifecycle("a", "running");
    expect(events).toEqual([]);
  });

  it("setActivity() emits session-activity-changed when value changes", () => {
    const reg = new SessionRegistry();
    reg.add(makeDescriptor("a"));
    const events: SessionEvent[] = [];
    reg.on((e) => events.push(e));
    reg.setActivity("a", "running-command");
    expect(events).toEqual([
      { type: "session-activity-changed", id: "a", activity: "running-command" },
    ]);
  });
});

describe("SessionRegistry — subscription", () => {
  it("on() returns an unsubscribe that stops further deliveries", () => {
    const reg = new SessionRegistry();
    const events: SessionEvent[] = [];
    const unsub = reg.on((e) => events.push(e));
    reg.add(makeDescriptor("a"));
    unsub();
    reg.add(makeDescriptor("b"));
    expect(events.map((e) => (e.type === "session-added" ? e.descriptor.id : "?"))).toEqual(["a"]);
  });

  it("listener exception does not break other listeners or caller", () => {
    const reg = new SessionRegistry();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const okEvents: SessionEvent[] = [];
    reg.on(() => {
      throw new Error("boom");
    });
    reg.on((e) => okEvents.push(e));
    expect(() => reg.add(makeDescriptor("a"))).not.toThrow();
    expect(okEvents).toHaveLength(1);
    consoleError.mockRestore();
  });
});

describe("getSessionRegistry()", () => {
  it("returns the same instance across calls (singleton via hot-data)", () => {
    const a = getSessionRegistry();
    const b = getSessionRegistry();
    expect(a).toBe(b);
  });
});

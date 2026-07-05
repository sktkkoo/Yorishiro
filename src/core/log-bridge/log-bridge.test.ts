import type { LogEntry } from "@yorishiro/sdk";
import { describe, expect, it } from "vitest";
import { Time } from "../time";
import { createLogAPI, LogBridge } from "./log-bridge";

// ─── helpers ────────────────────────────────────────────────────────

interface TestBridge {
  bridge: LogBridge;
  time: Time;
  advance: (ms: number) => void;
  setClock: (ms: number) => void;
}

const makeTestBridge = (capacity?: number): TestBridge => {
  let currentClock = 1000;
  const time = new Time({ clock: () => currentClock });
  const bridge = new LogBridge(capacity === undefined ? { time } : { time, capacity });
  return {
    bridge,
    time,
    advance: (ms) => {
      currentClock += ms;
    },
    setClock: (ms) => {
      currentClock = ms;
    },
  };
};

// ─── tests ──────────────────────────────────────────────────────────

describe("LogBridge", () => {
  describe("construction", () => {
    it("constructs with default capacity and empty buffer", () => {
      const { bridge } = makeTestBridge();
      expect(bridge.size()).toBe(0);
    });

    it("accepts a custom capacity", () => {
      const { bridge } = makeTestBridge(5);
      expect(bridge.size()).toBe(0);
    });
  });

  describe("write + timestamp auto-fill", () => {
    it("appends one entry and fills timestamp from Time.now()", () => {
      const { bridge, setClock } = makeTestBridge();
      setClock(1234);
      bridge.write({ personaId: "alice", reaction: "startled" });
      expect(bridge.size()).toBe(1);
      const [entry] = bridge.tail(1);
      expect(entry.timestamp).toBe(1234);
      expect(entry.personaId).toBe("alice");
      expect(entry.reaction).toBe("startled");
    });

    it("preserves optional note and data", () => {
      const { bridge } = makeTestBridge();
      bridge.write({
        personaId: "alice",
        reaction: "curious",
        note: "heard a loud click",
        data: { decibels: 88 },
      });
      const [entry] = bridge.tail(1);
      expect(entry.note).toBe("heard a loud click");
      expect(entry.data).toEqual({ decibels: 88 });
    });

    it("leaves optional fields as undefined when not provided", () => {
      const { bridge } = makeTestBridge();
      bridge.write({ personaId: "alice", reaction: "startled" });
      const [entry] = bridge.tail(1);
      expect(entry.note).toBeUndefined();
      expect(entry.data).toBeUndefined();
    });

    it("starts entries with noticed: false on first observation", () => {
      const { bridge } = makeTestBridge();
      bridge.write({ personaId: "alice", reaction: "startled" });
      // The first read returns a pre-mutation snapshot; noticed should be false.
      const [entry] = bridge.read();
      expect(entry.noticed).toBe(false);
    });
  });

  describe("ring buffer overflow", () => {
    it("keeps all entries when under capacity", () => {
      const { bridge } = makeTestBridge(3);
      bridge.write({ personaId: "alice", reaction: "a" });
      bridge.write({ personaId: "alice", reaction: "b" });
      bridge.write({ personaId: "alice", reaction: "c" });
      expect(bridge.size()).toBe(3);
      const entries = bridge.tail(10);
      expect(entries.map((e) => e.reaction)).toEqual(["a", "b", "c"]);
    });

    it("drops the oldest entry when capacity is exceeded by one", () => {
      const { bridge } = makeTestBridge(3);
      bridge.write({ personaId: "alice", reaction: "a" });
      bridge.write({ personaId: "alice", reaction: "b" });
      bridge.write({ personaId: "alice", reaction: "c" });
      bridge.write({ personaId: "alice", reaction: "d" });
      expect(bridge.size()).toBe(3);
      const entries = bridge.tail(10);
      expect(entries.map((e) => e.reaction)).toEqual(["b", "c", "d"]);
    });

    it("retains only the last N entries when many writes overflow", () => {
      const { bridge } = makeTestBridge(3);
      for (let i = 0; i < 10; i++) {
        bridge.write({ personaId: "alice", reaction: `r${i}` });
      }
      expect(bridge.size()).toBe(3);
      const entries = bridge.tail(10);
      expect(entries.map((e) => e.reaction)).toEqual(["r7", "r8", "r9"]);
    });
  });

  describe("tail", () => {
    it("returns an empty array for tail(0)", () => {
      const { bridge } = makeTestBridge();
      bridge.write({ personaId: "alice", reaction: "a" });
      expect(bridge.tail(0)).toEqual([]);
    });

    it("returns all entries chronologically when count exceeds size", () => {
      const { bridge } = makeTestBridge();
      bridge.write({ personaId: "alice", reaction: "a" });
      bridge.write({ personaId: "alice", reaction: "b" });
      bridge.write({ personaId: "alice", reaction: "c" });
      const entries = bridge.tail(5);
      expect(entries.map((e) => e.reaction)).toEqual(["a", "b", "c"]);
    });

    it("returns the most recent N entries oldest-first", () => {
      const { bridge } = makeTestBridge();
      bridge.write({ personaId: "alice", reaction: "a" });
      bridge.write({ personaId: "alice", reaction: "b" });
      bridge.write({ personaId: "alice", reaction: "c" });
      bridge.write({ personaId: "alice", reaction: "d" });
      bridge.write({ personaId: "alice", reaction: "e" });
      const entries = bridge.tail(2);
      expect(entries.map((e) => e.reaction)).toEqual(["d", "e"]);
    });

    it("marks returned entries as noticed after the first observation", () => {
      const { bridge } = makeTestBridge();
      bridge.write({ personaId: "alice", reaction: "a" });
      bridge.write({ personaId: "alice", reaction: "b" });
      const first = bridge.tail(2);
      // First observation: snapshot is pre-mutation, so noticed is false.
      expect(first.map((e) => e.noticed)).toEqual([false, false]);
      // Second observation: the entries are now marked noticed internally.
      const second = bridge.tail(2);
      expect(second.map((e) => e.noticed)).toEqual([true, true]);
    });

    it("leaves entries not covered by tail unnoticed", () => {
      const { bridge } = makeTestBridge();
      for (let i = 0; i < 5; i++) {
        bridge.write({ personaId: "alice", reaction: `r${i}` });
      }
      bridge.tail(2); // notices r3, r4 only
      // r0..r2 were never observed — their first read should still show false.
      const older = bridge.read({ reaction: "r1" });
      expect(older[0].noticed).toBe(false);
    });
  });

  describe("read with filters", () => {
    it("returns all entries chronologically when no filter", () => {
      const { bridge, setClock } = makeTestBridge();
      setClock(1000);
      bridge.write({ personaId: "alice", reaction: "a" });
      setClock(2000);
      bridge.write({ personaId: "bob", reaction: "b" });
      setClock(3000);
      bridge.write({ personaId: "alice", reaction: "c" });
      const entries = bridge.read();
      expect(entries.map((e) => e.reaction)).toEqual(["a", "b", "c"]);
    });

    it("filters by since (timestamp >=)", () => {
      const { bridge, setClock } = makeTestBridge();
      setClock(1000);
      bridge.write({ personaId: "alice", reaction: "a" });
      setClock(2000);
      bridge.write({ personaId: "alice", reaction: "b" });
      setClock(3000);
      bridge.write({ personaId: "alice", reaction: "c" });
      const entries = bridge.read({ since: 2000 });
      expect(entries.map((e) => e.reaction)).toEqual(["b", "c"]);
    });

    it("filters by personaId (exact match)", () => {
      const { bridge } = makeTestBridge();
      bridge.write({ personaId: "alice", reaction: "a" });
      bridge.write({ personaId: "bob", reaction: "b" });
      bridge.write({ personaId: "alice", reaction: "c" });
      const entries = bridge.read({ personaId: "alice" });
      expect(entries.map((e) => e.reaction)).toEqual(["a", "c"]);
    });

    it("filters by reaction (exact match)", () => {
      const { bridge } = makeTestBridge();
      bridge.write({ personaId: "alice", reaction: "startled" });
      bridge.write({ personaId: "alice", reaction: "distressed" });
      bridge.write({ personaId: "bob", reaction: "distressed" });
      const entries = bridge.read({ reaction: "distressed" });
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.reaction === "distressed")).toBe(true);
    });

    it("returns the most recent N entries (oldest-first) when limit applies after filtering", () => {
      const { bridge, setClock } = makeTestBridge();
      setClock(1000);
      bridge.write({ personaId: "alice", reaction: "a" });
      setClock(2000);
      bridge.write({ personaId: "alice", reaction: "b" });
      setClock(3000);
      bridge.write({ personaId: "alice", reaction: "c" });
      setClock(4000);
      bridge.write({ personaId: "alice", reaction: "d" });
      const entries = bridge.read({ limit: 2 });
      expect(entries.map((e) => e.reaction)).toEqual(["c", "d"]);
    });

    it("returns empty array for limit: 0", () => {
      const { bridge } = makeTestBridge();
      bridge.write({ personaId: "alice", reaction: "a" });
      bridge.write({ personaId: "alice", reaction: "b" });
      expect(bridge.read({ limit: 0 })).toEqual([]);
    });

    it("ANDs multiple filters together", () => {
      const { bridge, setClock } = makeTestBridge();
      setClock(1000);
      bridge.write({ personaId: "alice", reaction: "a" });
      setClock(2000);
      bridge.write({ personaId: "bob", reaction: "b" });
      setClock(3000);
      bridge.write({ personaId: "alice", reaction: "c" });
      setClock(4000);
      bridge.write({ personaId: "alice", reaction: "d" });
      const entries = bridge.read({ since: 2000, personaId: "alice" });
      expect(entries.map((e) => e.reaction)).toEqual(["c", "d"]);
    });
  });

  describe("noticed side effect", () => {
    it("flips noticed from false to true across successive tail calls", () => {
      const { bridge } = makeTestBridge();
      bridge.write({ personaId: "alice", reaction: "a" });
      bridge.write({ personaId: "alice", reaction: "b" });
      const first = bridge.tail(2);
      expect(first.map((e) => e.noticed)).toEqual([false, false]);
      const second = bridge.tail(2);
      expect(second.map((e) => e.noticed)).toEqual([true, true]);
    });

    it("only notices entries matching the read filter, leaving non-matches unnoticed", () => {
      const { bridge } = makeTestBridge();
      bridge.write({ personaId: "alice", reaction: "startled" });
      bridge.write({ personaId: "alice", reaction: "curious" });
      bridge.write({ personaId: "alice", reaction: "distressed" });
      // Touch only 'curious' entries.
      bridge.read({ reaction: "curious" });
      // 'startled' was never observed — first read should still show false.
      const startled = bridge.read({ reaction: "startled" });
      expect(startled[0].noticed).toBe(false);
      // 'curious' was observed in the earlier read and internally flipped to
      // true; this fresh read should now see true.
      const curious = bridge.read({ reaction: "curious" });
      expect(curious[0].noticed).toBe(true);
    });
  });

  describe("clear", () => {
    it("clears the buffer and subsequent tail returns empty", () => {
      const { bridge } = makeTestBridge();
      bridge.write({ personaId: "alice", reaction: "a" });
      bridge.write({ personaId: "alice", reaction: "b" });
      expect(bridge.size()).toBe(2);
      bridge.clear();
      expect(bridge.size()).toBe(0);
      expect(bridge.tail(5)).toEqual([]);
    });
  });

  describe("createLogAPI adapter", () => {
    it("binds personaId into writes", () => {
      const { bridge } = makeTestBridge();
      const api = createLogAPI(bridge, "alice");
      api.write({ reaction: "startled" });
      const [entry] = bridge.tail(1);
      expect(entry.personaId).toBe("alice");
      expect(entry.reaction).toBe("startled");
    });

    it("delegates tail to the bridge and returns SDK-shaped entries", () => {
      const { bridge } = makeTestBridge();
      bridge.write({ personaId: "alice", reaction: "a" });
      bridge.write({ personaId: "bob", reaction: "b" });
      const api = createLogAPI(bridge, "alice");
      const tailed = api.tail(5);
      expect(tailed.map((e: LogEntry) => e.reaction)).toEqual(["a", "b"]);
      // Tail is intentionally NOT scoped to personaId: the adapter sees all
      // entries so the persona can observe sibling actions.
    });

    it("translates LogFilter.reactionType → bridge filter.reaction", () => {
      const { bridge } = makeTestBridge();
      bridge.write({ personaId: "alice", reaction: "startled" });
      bridge.write({ personaId: "alice", reaction: "distressed" });
      bridge.write({ personaId: "alice", reaction: "distressed" });
      const api = createLogAPI(bridge, "alice");
      const distressed = api.read({ reactionType: "distressed" });
      expect(distressed).toHaveLength(2);
      expect(distressed.every((e) => e.reaction === "distressed")).toBe(true);
    });

    it("does not cross-contaminate writes across persona-bound adapters", () => {
      const { bridge } = makeTestBridge();
      const alice = createLogAPI(bridge, "alice");
      const bob = createLogAPI(bridge, "bob");
      alice.write({ reaction: "startled" });
      bob.write({ reaction: "curious" });
      const entries = bridge.tail(5);
      expect(entries.map((e) => [e.personaId, e.reaction])).toEqual([
        ["alice", "startled"],
        ["bob", "curious"],
      ]);
    });
  });
});

import { describe, expect, it } from "vitest";
import { Time } from "../time";
import { createSubsystemLog, DevLog, type DevLogEntry } from "./dev-log";

// ─── helpers ────────────────────────────────────────────────────────

interface TestDevLog {
  log: DevLog;
  advance: (ms: number) => void;
  setClock: (ms: number) => void;
}

const makeTestDevLog = (opts?: {
  capacity?: number;
  enabled?: boolean;
  sink?: (entry: unknown) => void;
}): TestDevLog => {
  let currentClock = 1000;
  const time = new Time({ clock: () => currentClock });
  const log = new DevLog({
    time,
    capacity: opts?.capacity,
    enabled: opts?.enabled,
    sink: opts?.sink,
  });
  return {
    log,
    advance: (ms) => {
      currentClock += ms;
    },
    setClock: (ms) => {
      currentClock = ms;
    },
  };
};

// ─── tests ──────────────────────────────────────────────────────────

describe("DevLog", () => {
  describe("construction + write + tail", () => {
    it("appends one entry and fills timestamp from Time.now()", () => {
      const { log, setClock } = makeTestDevLog();
      setClock(4242);
      log.write({ subsystem: "App", note: "polling started" });
      expect(log.size()).toBe(1);
      const [entry] = log.tail(1);
      expect(entry.timestamp).toBe(4242);
      expect(entry.subsystem).toBe("App");
      expect(entry.note).toBe("polling started");
    });

    it("preserves optional phase and data", () => {
      const { log } = makeTestDevLog();
      log.write({
        subsystem: "EventBus",
        phase: "dispatch",
        note: "matched 2 listeners",
        data: { count: 2 },
      });
      const [entry] = log.tail(1);
      expect(entry.phase).toBe("dispatch");
      expect(entry.data).toEqual({ count: 2 });
    });

    it("starts entries with noticed: false on first observation", () => {
      const { log } = makeTestDevLog();
      log.write({ subsystem: "App" });
      const [entry] = log.read();
      expect(entry.noticed).toBe(false);
    });
  });

  describe("ring buffer overflow", () => {
    it("drops the oldest entries when capacity is exceeded", () => {
      const { log } = makeTestDevLog({ capacity: 3 });
      for (let i = 0; i < 5; i++) {
        log.write({ subsystem: "App", note: `r${i}` });
      }
      expect(log.size()).toBe(3);
      const entries = log.tail(10);
      expect(entries.map((e) => e.note)).toEqual(["r2", "r3", "r4"]);
    });
  });

  describe("noticed side effect", () => {
    it("flips noticed from false to true across successive tail calls", () => {
      const { log } = makeTestDevLog();
      log.write({ subsystem: "App", note: "a" });
      const first = log.tail(1);
      expect(first[0].noticed).toBe(false);
      const second = log.tail(1);
      expect(second[0].noticed).toBe(true);
    });
  });

  describe("read with filters", () => {
    it("filters by subsystem", () => {
      const { log } = makeTestDevLog();
      log.write({ subsystem: "App", note: "a" });
      log.write({ subsystem: "EventBus", note: "b" });
      log.write({ subsystem: "App", note: "c" });
      const entries = log.read({ subsystem: "App" });
      expect(entries.map((e) => e.note)).toEqual(["a", "c"]);
    });

    it("filters by phase", () => {
      const { log } = makeTestDevLog();
      log.write({ subsystem: "App", phase: "start", note: "a" });
      log.write({ subsystem: "App", phase: "dispatch", note: "b" });
      log.write({ subsystem: "EventBus", phase: "dispatch", note: "c" });
      const entries = log.read({ phase: "dispatch" });
      expect(entries.map((e) => e.note)).toEqual(["b", "c"]);
    });
  });

  describe("enabled flag", () => {
    it("makes write a no-op when enabled: false", () => {
      const { log } = makeTestDevLog({ enabled: false });
      log.write({ subsystem: "App", note: "nope" });
      expect(log.size()).toBe(0);
      expect(log.tail(1)).toEqual([]);
    });

    it("writes normally when enabled: true (default)", () => {
      const { log } = makeTestDevLog();
      log.write({ subsystem: "App", note: "yes" });
      expect(log.size()).toBe(1);
    });
  });

  describe("sink mirror", () => {
    it("calls sink with each written entry", () => {
      const seen: string[] = [];
      const { log } = makeTestDevLog({
        sink: (entry) => {
          seen.push((entry as DevLogEntry).note ?? "");
        },
      });
      log.write({ subsystem: "App", note: "a" });
      log.write({ subsystem: "App", note: "b" });
      expect(seen).toEqual(["a", "b"]);
    });

    it("does not call sink when enabled: false", () => {
      let calls = 0;
      const { log } = makeTestDevLog({
        enabled: false,
        sink: () => {
          calls++;
        },
      });
      log.write({ subsystem: "App", note: "nope" });
      expect(calls).toBe(0);
    });
  });

  describe("createSubsystemLog adapter", () => {
    it("binds subsystem into writes", () => {
      const { log } = makeTestDevLog();
      const appLog = createSubsystemLog(log, "App");
      appLog.write({ note: "polling started" });
      const [entry] = log.tail(1);
      expect(entry.subsystem).toBe("App");
      expect(entry.note).toBe("polling started");
    });

    it("does not cross-contaminate writes across adapters", () => {
      const { log } = makeTestDevLog();
      const appLog = createSubsystemLog(log, "App");
      const busLog = createSubsystemLog(log, "EventBus");
      appLog.write({ note: "a" });
      busLog.write({ phase: "dispatch", note: "b" });
      const entries = log.tail(5);
      expect(entries.map((e) => [e.subsystem, e.phase, e.note])).toEqual([
        ["App", undefined, "a"],
        ["EventBus", "dispatch", "b"],
      ]);
    });
  });
});

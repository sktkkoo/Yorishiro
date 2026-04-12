import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Time } from "./time";

describe("Time", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("now()", () => {
    it("returns the injected clock value", () => {
      const time = new Time({ clock: () => 42 });
      expect(time.now()).toBe(42);
    });

    it("reflects successive clock reads", () => {
      let t = 100;
      const time = new Time({ clock: () => t });
      expect(time.now()).toBe(100);
      t = 250;
      expect(time.now()).toBe(250);
    });

    it("defaults to Date.now when no clock is injected", () => {
      vi.setSystemTime(new Date("2026-04-12T00:00:00Z"));
      const time = new Time();
      expect(time.now()).toBe(new Date("2026-04-12T00:00:00Z").getTime());
    });
  });

  describe("after(ms)", () => {
    it("resolves after the given delay", async () => {
      const time = new Time();
      let resolved = false;
      const promise = time.after(500).then(() => {
        resolved = true;
      });

      await vi.advanceTimersByTimeAsync(499);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(resolved).toBe(true);

      await promise;
    });

    it("resolves to undefined", async () => {
      const time = new Time();
      const promise = time.after(10);
      await vi.advanceTimersByTimeAsync(10);
      await expect(promise).resolves.toBeUndefined();
    });
  });

  describe("schedule(ms, action)", () => {
    it("invokes the action after ms elapses", () => {
      const time = new Time();
      const action = vi.fn<() => void>();

      time.schedule(200, action);

      vi.advanceTimersByTime(199);
      expect(action).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(action).toHaveBeenCalledTimes(1);
    });

    it("does not invoke the action if cancelled before it fires", () => {
      const time = new Time();
      const action = vi.fn<() => void>();

      const handle = time.schedule(200, action);
      vi.advanceTimersByTime(100);
      handle.cancel();

      vi.advanceTimersByTime(500);
      expect(action).not.toHaveBeenCalled();
    });

    it("cancel() is idempotent — calling twice does not throw", () => {
      const time = new Time();
      const action = vi.fn<() => void>();

      const handle = time.schedule(100, action);
      handle.cancel();
      expect(() => handle.cancel()).not.toThrow();

      vi.advanceTimersByTime(200);
      expect(action).not.toHaveBeenCalled();
    });

    it("cancel() after the action has fired is a no-op", () => {
      const time = new Time();
      const action = vi.fn<() => void>();

      const handle = time.schedule(50, action);
      vi.advanceTimersByTime(50);
      expect(action).toHaveBeenCalledTimes(1);

      expect(() => handle.cancel()).not.toThrow();
      // no further invocations
      vi.advanceTimersByTime(1000);
      expect(action).toHaveBeenCalledTimes(1);
    });
  });

  describe("every(interval, action)", () => {
    it("invokes the action on every tick", () => {
      const time = new Time();
      const action = vi.fn<() => void>();

      time.every(100, action);

      vi.advanceTimersByTime(100);
      expect(action).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(100);
      expect(action).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(300);
      expect(action).toHaveBeenCalledTimes(5);
    });

    it("stops ticking once cancelled", () => {
      const time = new Time();
      const action = vi.fn<() => void>();

      const handle = time.every(100, action);
      vi.advanceTimersByTime(250);
      expect(action).toHaveBeenCalledTimes(2);

      handle.cancel();
      vi.advanceTimersByTime(1000);
      expect(action).toHaveBeenCalledTimes(2);
    });

    it("cancel() is idempotent", () => {
      const time = new Time();
      const action = vi.fn<() => void>();

      const handle = time.every(100, action);
      handle.cancel();
      expect(() => handle.cancel()).not.toThrow();

      vi.advanceTimersByTime(1000);
      expect(action).not.toHaveBeenCalled();
    });
  });

  describe("probability({ interval, probability, action })", () => {
    it("fires when random() returns below probability", () => {
      const time = new Time({ random: () => 0.1 });
      const action = vi.fn<() => void>();

      time.probability({ interval: 100, probability: 0.5, action });

      vi.advanceTimersByTime(100);
      expect(action).toHaveBeenCalledTimes(1);
    });

    it("does not fire when random() returns at or above probability", () => {
      const time = new Time({ random: () => 0.9 });
      const action = vi.fn<() => void>();

      time.probability({ interval: 100, probability: 0.5, action });

      vi.advanceTimersByTime(500);
      expect(action).not.toHaveBeenCalled();
    });

    it("produces alternating fires for alternating random values", () => {
      const values = [0.1, 0.9, 0.2, 0.99, 0.0];
      let i = 0;
      const time = new Time({ random: () => values[i++] ?? 1 });
      const action = vi.fn<() => void>();

      time.probability({ interval: 100, probability: 0.5, action });

      vi.advanceTimersByTime(500);
      // tick1 fire, tick2 skip, tick3 fire, tick4 skip, tick5 fire => 3
      expect(action).toHaveBeenCalledTimes(3);
    });

    it("cancellation stops future checks", () => {
      const time = new Time({ random: () => 0.0 });
      const action = vi.fn<() => void>();

      const handle = time.probability({ interval: 100, probability: 1, action });
      vi.advanceTimersByTime(200);
      expect(action).toHaveBeenCalledTimes(2);

      handle.cancel();
      vi.advanceTimersByTime(1000);
      expect(action).toHaveBeenCalledTimes(2);
    });
  });

  describe("afterJitter(min, max)", () => {
    it("resolves at min when random() returns 0", async () => {
      const time = new Time({ random: () => 0 });
      let resolved = false;
      const promise = time.afterJitter(100, 500).then(() => {
        resolved = true;
      });

      await vi.advanceTimersByTimeAsync(99);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(resolved).toBe(true);

      await promise;
    });

    it("resolves at max when random() returns 1", async () => {
      const time = new Time({ random: () => 1 });
      let resolved = false;
      const promise = time.afterJitter(100, 500).then(() => {
        resolved = true;
      });

      await vi.advanceTimersByTimeAsync(499);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(resolved).toBe(true);

      await promise;
    });

    it("uses a delay proportional to random() within [min, max]", async () => {
      // random() = 0.25 → delay = 100 + 0.25 * 400 = 200
      const time = new Time({ random: () => 0.25 });
      let resolved = false;
      const promise = time.afterJitter(100, 500).then(() => {
        resolved = true;
      });

      await vi.advanceTimersByTimeAsync(199);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(resolved).toBe(true);

      await promise;
    });

    it("resolves at the midpoint when random() returns 0.5", async () => {
      const time = new Time({ random: () => 0.5 });
      let resolved = false;
      const promise = time.afterJitter(100, 500).then(() => {
        resolved = true;
      });

      // midpoint = 100 + (500 - 100) * 0.5 = 300
      await vi.advanceTimersByTimeAsync(299);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(resolved).toBe(true);

      await promise;
    });
  });
});

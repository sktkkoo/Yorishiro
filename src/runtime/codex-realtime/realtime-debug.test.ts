// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  isRealtimeDebugEnabled,
  setRealtimeDebugEnabled,
  subscribeRealtimeDebug,
} from "./realtime-debug";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
it("requires the exact local opt-in flag and permits explicit disable", () => {
  expect(isRealtimeDebugEnabled()).toBe(false);
  localStorage.setItem("yorishiro:realtime-debug", "true");
  expect(isRealtimeDebugEnabled()).toBe(false);
  const listener = vi.fn();
  const stop = subscribeRealtimeDebug(listener);
  setRealtimeDebugEnabled(true);
  expect(isRealtimeDebugEnabled()).toBe(true);
  expect(listener).toHaveBeenCalledOnce();
  setRealtimeDebugEnabled(false);
  expect(isRealtimeDebugEnabled()).toBe(false);
  stop();
  setRealtimeDebugEnabled(true);
  expect(listener).toHaveBeenCalledTimes(2);
});
it("fails closed if local storage is inaccessible", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(isRealtimeDebugEnabled()).toBe(false);
});

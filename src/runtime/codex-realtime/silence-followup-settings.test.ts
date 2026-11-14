// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { setRealtimeDebugEnabled } from "./realtime-debug";
import {
  DEFAULT_SILENCE_FOLLOWUP,
  readSilenceFollowupSettings,
  subscribeSilenceFollowupSettings,
  writeSilenceFollowupSettings,
} from "./silence-followup-settings";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
it("requires both local opt-ins, uses safe defaults and reacts immediately to disable", () => {
  const enabled = { enabled: true, silenceSeconds: 60, cooldownSeconds: 300 };
  writeSilenceFollowupSettings(enabled);
  expect(readSilenceFollowupSettings()).toEqual(DEFAULT_SILENCE_FOLLOWUP);
  setRealtimeDebugEnabled(true);
  expect(readSilenceFollowupSettings().enabled).toBe(false);
  const listener = vi.fn();
  const stop = subscribeSilenceFollowupSettings(listener);
  writeSilenceFollowupSettings(enabled);
  expect(readSilenceFollowupSettings()).toEqual(enabled);
  expect(listener).toHaveBeenCalledOnce();
  setRealtimeDebugEnabled(false);
  expect(readSilenceFollowupSettings().enabled).toBe(false);
  expect(listener).toHaveBeenCalledTimes(2);
  stop();
});
it("bounds configuration and fails closed when storage cannot be read", () => {
  setRealtimeDebugEnabled(true);
  writeSilenceFollowupSettings({ enabled: true, silenceSeconds: NaN, cooldownSeconds: -1 });
  expect(readSilenceFollowupSettings()).toEqual({ ...DEFAULT_SILENCE_FOLLOWUP, enabled: true });
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(readSilenceFollowupSettings().enabled).toBe(false);
});

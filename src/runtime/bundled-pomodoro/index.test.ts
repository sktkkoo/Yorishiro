import type { HistoryAPI } from "@yorishiro/sdk";
import { describe, expect, it, vi } from "vitest";
import type { TweenManager } from "../../core/tween/tween-manager";
import { AmenityPackRegistryImpl } from "../amenity-pack-registry";
import { registerBundledPomodoro } from "./index";

const history: HistoryAPI = {
  list: async () => [],
  snapshot: async () => 1,
  restore: async () => true,
};

function tweenManager(): TweenManager {
  return {
    start: vi.fn(),
    startVec3: vi.fn(),
    cancel: vi.fn(),
  } as unknown as TweenManager;
}

describe("registerBundledPomodoro", () => {
  it("publishes a narrow state/stop service separately from MCP tools", async () => {
    const registry = new AmenityPackRegistryImpl();
    const disposable = registerBundledPomodoro({
      registry,
      tweenManager: tweenManager(),
      setTerminalOpacity: vi.fn(),
      getTerminalOpacity: () => 1,
      emitEvent: vi.fn(),
      loop: vi.fn(),
      history,
    });
    const handle = registry.getActiveHandle("pomodoro");

    expect(handle?.service).toBeDefined();
    expect(handle?.service).not.toBe(handle?.tools);
    await handle?.tools.pomodoro_start({ workMs: 60_000, rounds: 2 });
    await expect(handle?.service?.getState()).resolves.toMatchObject({
      phase: "work",
      round: 1,
      totalRounds: 2,
    });
    await expect(handle?.service?.execute("stop")).resolves.toMatchObject({
      cancelled: true,
      phase: "work",
      round: 1,
    });
    await expect(handle?.service?.getState()).resolves.toMatchObject({ phase: "idle" });
    await expect(handle?.service?.execute("pomodoro_start")).rejects.toThrow(
      "unknown pomodoro service command 'pomodoro_start'",
    );

    disposable.dispose();
  });
});

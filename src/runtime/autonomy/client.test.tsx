// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const idle = { contract: null, phase: "idle", nextRunAt: null, runs: [], error: null };

describe("autonomous host polling", () => {
  beforeEach(() => {
    vi.resetModules();
    invoke.mockReset();
    invoke.mockImplementation(async (command: string) =>
      command === "autonomy_status" ? idle : undefined,
    );
  });
  afterEach(() => vi.useRealTimers());

  it("checks for due work without user input and stops polling after unmount", async () => {
    vi.useFakeTimers();
    const { useAutonomyStatus } = await import("./client");
    const view = renderHook(useAutonomyStatus);
    await act(async () => {});
    expect(view.result.current).toEqual(idle);
    expect(invoke.mock.calls.filter(([name]) => name === "autonomy_tick")).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(invoke.mock.calls.filter(([name]) => name === "autonomy_tick")).toHaveLength(2);
    view.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(invoke.mock.calls.filter(([name]) => name === "autonomy_tick")).toHaveLength(2);
  });

  it("shows a first-load backend failure instead of staying on a loading screen", async () => {
    invoke.mockRejectedValue(new Error("state unavailable"));
    const { useAutonomyStatus } = await import("./client");
    const view = renderHook(useAutonomyStatus);
    await waitFor(() => expect(view.result.current?.error).toContain("state unavailable"));
    view.unmount();
  });

  it("keeps the saved contract visible when a due run cannot start", async () => {
    const saved = { ...idle, contract: { goal: "整理", enabled: true } };
    invoke.mockImplementation(async (command: string) => {
      if (command === "autonomy_tick") throw new Error("folder missing");
      return saved;
    });
    const { useAutonomyStatus } = await import("./client");
    const view = renderHook(useAutonomyStatus);
    await waitFor(() => expect(view.result.current?.error).toContain("folder missing"));
    expect(view.result.current?.contract).toEqual(saved.contract);
    view.unmount();
  });

  it.each([
    "pause",
    "toggle",
  ] as const)("refreshes after an in-flight stale status read when %s turns work Off", async (action) => {
    vi.useFakeTimers();
    const enabled = {
      ...idle,
      contract: {
        goal: "メモを整理する",
        root: "/Users/test/notes",
        allowedOperations: ["write"],
        intervalMinutes: 30,
        maxRunsPerDay: 4,
        enabled: true,
      },
    };
    const disabled = {
      ...enabled,
      phase: "paused",
      contract: { ...enabled.contract, enabled: false },
    };
    let resolveStale: (value: typeof enabled) => void = () => {
      throw new Error("Deferred status not initialized");
    };
    const staleRead = new Promise<typeof enabled>((resolve) => {
      resolveStale = resolve;
    });
    let backend = enabled;
    let statusReads = 0;
    invoke.mockImplementation(async (command: string) => {
      if (command === "autonomy_status") {
        statusReads += 1;
        return statusReads === 2 ? staleRead : backend;
      }
      if (command === "autonomy_pause" || command === "autonomy_set_enabled") {
        backend = disabled;
      }
      return undefined;
    });

    const client = await import("./client");
    const view = renderHook(client.useAutonomyStatus);
    await act(async () => {});
    expect(view.result.current?.contract?.enabled).toBe(true);

    // A periodic status request began while the work was still enabled.
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(statusReads).toBe(2);
    let settled = false;
    let completion = Promise.resolve();
    await act(async () => {
      completion = (
        action === "pause" ? client.pauseAutonomy() : client.setAutonomyEnabled(false)
      ).then(() => {
        settled = true;
      });
      await Promise.resolve();
    });
    expect(backend.contract.enabled).toBe(false);
    expect(settled).toBe(false);
    expect(view.result.current?.contract?.enabled).toBe(true);

    // The stale On response must be followed by a fresh read, without waiting
    // for another 15-second tick or starting a second concurrent poll.
    await act(async () => {
      resolveStale(enabled);
      await completion;
    });
    expect(settled).toBe(true);
    expect(statusReads).toBe(3);
    expect(view.result.current).toEqual(disabled);
    if (action === "toggle") {
      expect(invoke).toHaveBeenCalledWith("autonomy_set_enabled", { enabled: false });
    }
    view.unmount();
  });
});

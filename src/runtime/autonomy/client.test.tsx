// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, listen, unlisten } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

const idle = { contract: null, phase: "idle", nextRunAt: null, runs: [], error: null };

describe("autonomous host polling", () => {
  beforeEach(() => {
    vi.resetModules();
    invoke.mockReset();
    unlisten.mockReset();
    listen.mockReset().mockResolvedValue(unlisten);
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

const draft = (id: string) => ({
  id,
  goal: `目的 ${id}`,
  root: "/notes",
  allowedOperations: ["write"] as const,
  intervalMinutes: 30,
  maxRunsPerDay: 4,
  reviewMode: "daily" as const,
  explanation: "相談中",
});

describe("live shared setup draft", () => {
  beforeEach(() => {
    vi.resetModules();
    unlisten.mockReset();
    listen.mockReset().mockResolvedValue(unlisten);
    invoke.mockReset().mockImplementation(async (command: string) => {
      if (command === "autonomy_status") return idle;
      if (command === "autonomy_draft_snapshot") return { revision: 0, draft: null };
    });
  });
  afterEach(() => vi.useRealTimers());

  it("keeps a failed subscription visible across polls and reconnects automatically", async () => {
    vi.useFakeTimers();
    listen.mockRejectedValueOnce(new Error("event bridge offline"));
    const client = await import("./client");
    const view = renderHook(() => ({
      status: client.useAutonomyStatus(),
      draft: client.useAutonomyDraftSnapshot(),
    }));
    await act(async () => {});
    expect(view.result.current.status?.error).toContain("event bridge offline");
    await act(async () => {
      await client.pauseAutonomy();
    });
    expect(view.result.current.status?.error).toContain("event bridge offline");
    expect(listen).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(listen).toHaveBeenCalledTimes(2);
    expect(view.result.current.status?.error).toBeNull();
    act(() => listen.mock.calls[1][1]({ payload: { revision: 1, draft: draft("reconnected") } }));
    expect(view.result.current.draft.draft?.id).toBe("reconnected");
    view.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(listen).toHaveBeenCalledTimes(2);
  });

  it("reflects native voice changes immediately and never regresses to stale polls or edits", async () => {
    vi.useFakeTimers();
    const client = await import("./client");
    const view = renderHook(client.useAutonomyDraftSnapshot);
    await act(async () => {});
    const emit = listen.mock.calls[0][1];
    expect(listen.mock.calls[0][0]).toBe("autonomy:draft-changed");
    act(() => emit({ payload: { revision: 3, draft: draft("voice") } }));
    expect(view.result.current.draft?.id).toBe("voice");
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(view.result.current.revision).toBe(3);
    invoke.mockImplementation(async (command: string) =>
      command === "autonomy_draft_edit"
        ? { snapshot: { revision: 2, draft: draft("old") }, conflict: false }
        : idle,
    );
    await act(async () => {
      await client.editAutonomyDraft("old", { goal: "手入力" });
    });
    expect(view.result.current.draft?.id).toBe("voice");
    act(() => emit({ payload: { revision: 4, draft: null } }));
    act(() => emit({ payload: { revision: 3, draft: draft("voice") } }));
    expect(view.result.current).toEqual({ revision: 4, draft: null });
    view.unmount();
    expect(unlisten).toHaveBeenCalledOnce();
    act(() => emit({ payload: { revision: 5, draft: draft("late") } }));
    expect(view.result.current.revision).toBe(4);
  });

  it("fetches again after listener registration closes an initial read gap", async () => {
    let resolveListen!: (stop: () => void) => void;
    listen.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveListen = resolve;
        }),
    );
    const client = await import("./client");
    const view = renderHook(client.useAutonomyDraftSnapshot);
    await waitFor(() => expect(view.result.current.revision).toBe(0));
    invoke.mockImplementation(async (command: string) =>
      command === "autonomy_draft_snapshot" ? { revision: 1, draft: draft("gap") } : idle,
    );
    await act(async () => {
      resolveListen(unlisten);
    });
    expect(view.result.current.draft?.id).toBe("gap");
    view.unmount();
  });

  it("disposes a listener that finishes registering after unmount", async () => {
    let resolveListen!: (stop: () => void) => void;
    listen.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveListen = resolve;
        }),
    );
    const client = await import("./client");
    const view = renderHook(client.useAutonomyDraftSnapshot);
    await act(async () => {});
    view.unmount();
    await act(async () => {
      resolveListen(unlisten);
    });
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("shares a consultation's committed snapshot without activating permissions", async () => {
    const client = await import("./client");
    const view = renderHook(client.useAutonomyDraftSnapshot);
    await act(async () => {});
    const reply = {
      reply: "更新しました",
      suggestedGoal: "相談結果",
      suggestedOperations: [],
      draftSnapshot: { revision: 2, draft: draft("consult") },
      draftConflict: false,
    };
    invoke.mockImplementation(async () => reply);
    await act(async () => {
      expect(await client.consultAutonomy([])).toEqual(reply);
    });
    expect(view.result.current.draft?.id).toBe("consult");
    expect(invoke.mock.calls.some(([name]) => name === "autonomy_save")).toBe(false);
    view.unmount();
  });

  it("dismisses only the reviewed ID even when a newer voice draft arrives during save", async () => {
    const client = await import("./client");
    const view = renderHook(client.useAutonomyDraftSnapshot);
    await act(async () => {});
    const emit = listen.mock.calls[0][1];
    let resolveSave!: () => void;
    invoke.mockImplementation(async (command: string) => {
      if (command === "autonomy_save")
        return new Promise<void>((resolve) => {
          resolveSave = resolve;
        });
      if (command === "autonomy_status") return idle;
      if (command === "autonomy_draft_snapshot") return { revision: 3, draft: draft("newer") };
    });
    let saving!: Promise<void>;
    await act(async () => {
      saving = client.saveAutonomyContract({ ...draft("reviewed"), enabled: true }, "reviewed");
    });
    act(() => emit({ payload: { revision: 3, draft: draft("newer") } }));
    await act(async () => {
      resolveSave();
      await saving;
    });
    expect(invoke).toHaveBeenCalledWith("autonomy_draft_dismiss", { id: "reviewed" });
    expect(view.result.current.draft?.id).toBe("newer");
    view.unmount();
  });
});

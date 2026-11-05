// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isUiPackHostReady } from "../../ui-pack-activation";
import { continuityExecutionRoute, useContinuityExecutionPreference } from "./execution-routing";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
beforeEach(() => {
  native.invoke.mockReset();
});
afterEach(() => cleanup());

describe("host-owned continuity routing", () => {
  it("waits for host preference before choosing any execution route", async () => {
    let resolve!: (value: unknown) => void;
    native.invoke.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = renderHook(() => useContinuityExecutionPreference());
    expect(view.result.current).toBeUndefined();
    expect(continuityExecutionRoute(view.result.current, "codex", "main", true)).toBeNull();
    await act(async () => resolve("pi"));
    expect(continuityExecutionRoute(view.result.current, "codex", "main", true)).toEqual({
      backend: "pi",
      sessionId: null,
    });
    expect(continuityExecutionRoute(view.result.current, "claude", "replacement", true)).toEqual({
      backend: "pi",
      sessionId: null,
    });
  });

  it("keeps the existing route when no dedicated worker is selected", async () => {
    native.invoke.mockResolvedValue(null);
    const view = renderHook(() => useContinuityExecutionPreference());
    await act(async () => {});
    expect(continuityExecutionRoute(view.result.current, "codex", "main", true)).toEqual({
      backend: "codex",
      sessionId: "main",
    });
    expect(continuityExecutionRoute(view.result.current, "claude", "main", true)).toEqual({
      backend: "text",
      sessionId: null,
    });
  });

  it.each([
    [false, true, true],
    [true, false, true],
    [true, true, false],
  ])("waits for each Codex startup gate (%s, %s, %s)", (userLayer, restore, prompt) => {
    const startupReady = isUiPackHostReady(userLayer, restore, prompt);
    expect(continuityExecutionRoute(null, "codex", null, startupReady)).toBeNull();
    expect(continuityExecutionRoute(null, "codex", "main", startupReady)).toBeNull();
    expect(continuityExecutionRoute("pi", "codex", null, startupReady)).toEqual({
      backend: "pi",
      sessionId: null,
    });
    expect(continuityExecutionRoute(null, "claude", null, startupReady)).toEqual({
      backend: "text",
      sessionId: null,
    });
  });

  it("enables the Codex route after startup and preserves unavailable-agent diagnostics", () => {
    const startupReady = isUiPackHostReady(true, true, true);
    expect(continuityExecutionRoute(null, "codex", "main", startupReady)).toEqual({
      backend: "codex",
      sessionId: "main",
    });
    expect(continuityExecutionRoute(null, "codex", null, startupReady)).toEqual({
      backend: "codex",
      sessionId: null,
    });
    expect(continuityExecutionRoute(undefined, "codex", "main", startupReady)).toBeNull();
    expect(continuityExecutionRoute(undefined, "codex", null, false)).toBeNull();
  });

  it("supports an older running host without mistaking storage failure for legacy routing", async () => {
    native.invoke.mockRejectedValue("Command continuity_execution_backend not found");
    const view = renderHook(() => useContinuityExecutionPreference());
    await act(async () => {});
    expect(view.result.current).toBeNull();
    native.invoke.mockRejectedValue("Cannot inspect Pi execution settings");
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(view.result.current).toBe("pi");
    expect(continuityExecutionRoute(view.result.current, "codex", "main", true)?.backend).toBe(
      "pi",
    );
  });

  it("does not replace a newer Pi selection with a stale startup response", async () => {
    const pending: Array<(value: unknown) => void> = [];
    native.invoke.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const view = renderHook(() => useContinuityExecutionPreference());
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => pending[1]("pi"));
    await act(async () => pending[0](null));
    expect(view.result.current).toBe("pi");
  });

  it("fails closed for an invalid host preference", async () => {
    native.invoke.mockResolvedValue({ backend: "unknown" });
    const view = renderHook(() => useContinuityExecutionPreference());
    await act(async () => {});
    expect(view.result.current).toBe("pi");
  });
});

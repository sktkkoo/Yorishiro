// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContinuityWorkspace,
  type ContinuityWorkspaceProps,
} from "../../components/ContinuityWorkspace";
import { loadPiDiagnostics, parsePiDiagnostics, usePiDiagnostics } from "./pi-diagnostics";

const native = vi.hoisted(() => ({ invoke: vi.fn(), retry: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("./client", () => ({
  useContinuity: () => ({ snapshot: null, error: "Existing worker is unavailable" }),
  retryContinuity: native.retry,
  sendContinuityMessage: vi.fn(),
  actOnContinuityDraft: vi.fn(),
}));

function payload(ready = false) {
  return {
    protocol: 1,
    ready,
    checks: [
      { name: "node", status: "ok", code: "node_supported" },
      { name: "configuration", status: "ok", code: "configuration_valid" },
      { name: "dependencies", status: "ok", code: "dependencies_available" },
      { name: "model", status: "ok", code: "model_available" },
      {
        name: "authentication",
        status: ready ? "ok" : "missing",
        code: ready ? "authentication_present" : "authentication_missing",
      },
    ],
  };
}
function deferred() {
  let resolve: (value: unknown) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  native.invoke.mockReset();
  native.retry.mockReset();
  native.invoke.mockResolvedValue(payload());
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("manual Pi connection diagnostics", () => {
  it("rejects unknown checks, duplicate names, unsafe fields and inconsistent ready claims", async () => {
    expect(parsePiDiagnostics(payload())).not.toBeNull();
    const bad = [
      { ...payload(), ready: true },
      { ...payload(), secret: "PRIVATE_PAYLOAD" },
      { ...payload(), checks: payload().checks.slice(1) },
      { ...payload(), checks: [...payload().checks.slice(0, 4), payload().checks[0]] },
      {
        ...payload(),
        checks: [
          { name: "node", status: "ok", code: "PRIVATE_PAYLOAD" },
          ...payload().checks.slice(1),
        ],
      },
      {
        ...payload(),
        checks: [
          { ...payload().checks[0], detail: "PRIVATE_PAYLOAD" },
          ...payload().checks.slice(1),
        ],
      },
    ];
    for (const value of bad) {
      expect(parsePiDiagnostics(value)).toBeNull();
      native.invoke.mockResolvedValueOnce(value);
      expect(await loadPiDiagnostics("/workspace")).toEqual({
        ok: false,
        code: "diagnostic_invalid",
      });
    }
  });

  it.each([
    "cwd",
    "closed",
    "backend",
  ])("discards a stale result after %s changes, including returning to the old context", async (change) => {
    const old = deferred();
    const current = deferred();
    native.invoke.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const initial = { cwd: "/one", open: true, backend: "pi" };
    const view = renderHook(({ cwd, open, backend }) => usePiDiagnostics(cwd, open, backend), {
      initialProps: initial,
    });
    expect(native.invoke).not.toHaveBeenCalled();
    let request: Promise<void>;
    act(() => {
      request = view.result.current.check();
    });
    expect(view.result.current.checking).toBe(true);
    act(() => {
      void view.result.current.check();
    });
    expect(native.invoke).toHaveBeenCalledTimes(1);
    const changed =
      change === "cwd"
        ? { ...initial, cwd: "/two" }
        : change === "closed"
          ? { ...initial, open: false }
          : { ...initial, backend: "codex" };
    view.rerender(changed);
    view.rerender(initial);
    expect(view.result.current.checking).toBe(false);
    expect(view.result.current.result).toBeNull();
    let latest: Promise<void>;
    act(() => {
      latest = view.result.current.check();
    });
    await act(async () => {
      old.resolve(payload(true));
      await request;
    });
    expect(view.result.current.result).toBeNull();
    expect(view.result.current.checking).toBe(true);
    await act(async () => {
      current.resolve(payload());
      await latest;
    });
    expect(view.result.current.checking).toBe(false);
    expect(view.result.current.result?.ok).toBe(true);
    expect(native.invoke).toHaveBeenCalledWith("continuity_pi_diagnostics", { cwd: "/one" });
  });

  it("does not restore an old pending request when returning to its folder without checking again", async () => {
    const pending = deferred();
    native.invoke.mockReturnValueOnce(pending.promise);
    const view = renderHook(({ cwd }) => usePiDiagnostics(cwd, true, "pi"), {
      initialProps: { cwd: "/one" },
    });
    let request: Promise<void>;
    act(() => {
      request = view.result.current.check();
    });
    view.rerender({ cwd: "/two" });
    view.rerender({ cwd: "/one" });
    expect(view.result.current.checking).toBe(false);
    expect(view.result.current.result).toBeNull();
    await act(async () => {
      pending.resolve(payload(true));
      await request;
    });
    expect(view.result.current.checking).toBe(false);
    expect(view.result.current.result).toBeNull();
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });

  it("does not invoke while closed or on another backend, and drops unmounted results", async () => {
    const pending = deferred();
    const view = renderHook(({ open, backend }) => usePiDiagnostics(null, open, backend), {
      initialProps: { open: false, backend: "pi" },
    });
    await act(async () => view.result.current.check());
    view.rerender({ open: true, backend: "codex" });
    await act(async () => view.result.current.check());
    expect(native.invoke).not.toHaveBeenCalled();
    view.rerender({ open: true, backend: "pi" });
    native.invoke.mockReturnValueOnce(pending.promise);
    let check: Promise<void>;
    act(() => {
      check = view.result.current.check();
    });
    view.unmount();
    await act(async () => {
      pending.resolve(payload());
      await check;
    });
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });

  it("clears completed results across context changes even when returning to the same folder", async () => {
    const initial = { cwd: "/one", open: true, backend: "pi" };
    const view = renderHook(({ cwd, open, backend }) => usePiDiagnostics(cwd, open, backend), {
      initialProps: initial,
    });
    for (const changed of [
      { ...initial, cwd: "/two" },
      { ...initial, open: false },
      { ...initial, backend: "codex" },
    ]) {
      await act(async () => view.result.current.check());
      expect(view.result.current.result?.ok).toBe(true);
      const calls = native.invoke.mock.calls.length;
      view.rerender(changed);
      view.rerender(initial);
      expect(view.result.current.result).toBeNull();
      expect(view.result.current.checking).toBe(false);
      expect(native.invoke.mock.calls.length).toBe(calls);
    }
  });

  it("shows only localized safe messages on an explicit UI click and leaves retry alone", async () => {
    const props: ContinuityWorkspaceProps = {
      open: true,
      language: "ja",
      cwd: "/workspace",
      personaId: "yori-ja",
      personaName: "Yori",
      personaInstructions: "",
      executionBackend: "pi",
      onClose: vi.fn(),
    };
    const pending = deferred();
    native.invoke.mockReturnValueOnce(pending.promise);
    const view = render(<ContinuityWorkspace {...props} />);
    expect(native.invoke).not.toHaveBeenCalled();
    const button = screen.getByRole("button", { name: "接続を確認" });
    fireEvent.click(button);
    expect((screen.getByRole("button", { name: "確認中…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => pending.reject(new Error("PRIVATE_CREDENTIAL_SENTINEL")));
    expect(screen.getByRole("status").textContent).toContain("接続状態を確認できませんでした");
    expect(document.body.textContent).not.toContain("PRIVATE_CREDENTIAL_SENTINEL");
    expect(native.retry).not.toHaveBeenCalled();
    native.invoke.mockResolvedValueOnce({ ...payload(true), message: "PRIVATE_PAYLOAD_SENTINEL" });
    fireEvent.click(screen.getByRole("button", { name: "接続を確認" }));
    await screen.findByText("接続状態を確認できませんでした。しばらくしてから再確認してください。");
    expect(document.body.textContent).not.toContain("PRIVATE_PAYLOAD_SENTINEL");
    view.rerender(<ContinuityWorkspace {...props} language="en" />);
    native.invoke.mockResolvedValueOnce(payload(true));
    fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
    await screen.findByText(/Authentication validity and model responses have not been verified/);
    expect(screen.getByRole("status").textContent).toContain("Pi connection settings are present");
    view.rerender(<ContinuityWorkspace {...props} executionBackend="codex" />);
    expect(screen.queryByRole("button", { name: "接続を確認" })).toBeNull();
  });

  it("accepts only the exact invalid authentication status and displays a fixed localized message", async () => {
    const invalid = {
      ...payload(),
      checks: [
        ...payload().checks.slice(0, 4),
        { name: "authentication", status: "invalid", code: "authentication_invalid" },
      ],
    };
    expect(parsePiDiagnostics(invalid)).toEqual(invalid);
    expect(
      parsePiDiagnostics({
        ...invalid,
        checks: [
          ...invalid.checks.slice(0, 4),
          { name: "authentication", status: "missing", code: "authentication_invalid" },
        ],
      }),
    ).toBeNull();
    native.invoke.mockResolvedValue(invalid);
    expect(await loadPiDiagnostics("/workspace")).toEqual({ ok: true, diagnostics: invalid });
    const props: ContinuityWorkspaceProps = {
      open: true,
      language: "ja",
      cwd: "/workspace",
      personaId: "yori-ja",
      personaName: "Yori",
      personaInstructions: "",
      executionBackend: "pi",
      onClose: vi.fn(),
    };
    const view = render(<ContinuityWorkspace {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "接続を確認" }));
    await screen.findByText("設定した接続先の認証情報を確認してください。");
    expect(screen.getByRole("status").textContent).not.toContain("接続状態を確認できませんでした");
    expect(screen.getByRole("status").textContent).not.toContain("authentication_invalid");
    view.rerender(<ContinuityWorkspace {...props} language="en" />);
    expect(screen.getByRole("status").textContent).toBe(
      "Check the credentials for the configured connection.",
    );
    expect(native.retry).not.toHaveBeenCalled();
  });
});

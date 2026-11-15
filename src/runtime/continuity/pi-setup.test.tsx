// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PiSettings,
  type PiSetupStatus,
  parsePiLogin,
  parsePiSetup,
  usePiSetup,
} from "./pi-setup";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
const status = (configured = false): PiSetupStatus => ({
  runtimeReady: true,
  configured,
  legacyConfiguration: false,
  authenticated: true,
  authentication: "present",
  model: "model",
  models: [{ id: "model", name: "Model" }],
  permissions: { read: true, write: false, commands: [] },
  workspaceAvailable: true,
  login: { phase: "idle", code: null },
  code: null,
});
beforeEach(() => {
  native.invoke.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function deferredStatus() {
  let resolve!: (value: PiSetupStatus) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<PiSetupStatus>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
describe("Pi setup bridge", () => {
  it("coalesces synchronous manual rechecks and keeps the loaded status visible", async () => {
    const pending = deferredStatus();
    native.invoke.mockResolvedValueOnce(status()).mockReturnValueOnce(pending.promise);
    const hook = renderHook(() => usePiSetup("workspace"));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = hook.result.current.refresh();
      second = hook.result.current.refresh();
    });
    expect(first).toBe(second);
    expect(native.invoke).toHaveBeenCalledTimes(2);
    expect(hook.result.current.checking).toBe(true);
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.status?.configured).toBe(false);
    await act(async () => pending.resolve(status(true)));
    expect(hook.result.current.checking).toBe(false);
    expect(hook.result.current.status?.configured).toBe(true);
  });

  it.each([
    "success",
    "failure",
  ] as const)("queues one fresh check after focus/configuration invalidation and ignores obsolete %s", async (outcome) => {
    const previous = deferredStatus();
    const fresh = deferredStatus();
    native.invoke
      .mockResolvedValueOnce(status())
      .mockReturnValueOnce(previous.promise)
      .mockReturnValueOnce(fresh.promise);
    const hook = renderHook(() => usePiSetup("workspace"));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    act(() => {
      void hook.result.current.refresh();
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("yorishiro:pi-configured"));
      window.dispatchEvent(new Event("yorishiro:pi-configured"));
    });
    await act(async () =>
      outcome === "success"
        ? previous.resolve(status())
        : previous.reject(new Error("setup_unavailable")),
    );
    expect(native.invoke).toHaveBeenCalledTimes(3);
    expect(hook.result.current.checking).toBe(true);
    expect(hook.result.current.error).toBeNull();
    await act(async () => fresh.resolve(status(true)));
    expect(hook.result.current.status?.configured).toBe(true);
    expect(hook.result.current.checking).toBe(false);
    expect(native.invoke).toHaveBeenCalledTimes(3);
  });

  it("keeps accepted saved settings authoritative while replacing an older status check", async () => {
    const previous = deferredStatus();
    const fresh = deferredStatus();
    const saved = { ...status(true), permissions: { read: true, write: true, commands: [] } };
    let reads = 0;
    native.invoke.mockImplementation((name) =>
      name === "continuity_pi_setup_save"
        ? Promise.resolve(saved)
        : ++reads === 1
          ? Promise.resolve(status())
          : reads === 2
            ? previous.promise
            : fresh.promise,
    );
    const hook = renderHook(() => usePiSetup("workspace"));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    act(() => {
      void hook.result.current.refresh();
    });
    await act(async () => {
      await hook.result.current.save({
        version: 2,
        enabled: true,
        provider: "openai",
        model: "model",
        authMode: "oauth",
        permissions: saved.permissions,
      });
    });
    expect(hook.result.current.status?.permissions.write).toBe(true);
    await act(async () => previous.resolve(status()));
    expect(hook.result.current.status?.permissions.write).toBe(true);
    expect(hook.result.current.checking).toBe(true);
    expect(reads).toBe(3);
    await act(async () => fresh.resolve(saved));
    expect(hook.result.current.checking).toBe(false);
  });

  it("preserves login acknowledgements and terminal polling invalidation during pending checks", async () => {
    const beforeLogin = deferredStatus();
    const duringLogin = deferredStatus();
    let reads = 0;
    native.invoke.mockImplementation((name) => {
      if (name === "continuity_pi_login_start")
        return Promise.resolve({ phase: "waiting", code: null });
      if (name === "continuity_pi_login_status")
        return Promise.resolve({ phase: "connected", code: null });
      reads += 1;
      return reads === 1
        ? Promise.resolve(status())
        : reads === 2
          ? beforeLogin.promise
          : reads === 3
            ? duringLogin.promise
            : Promise.resolve({ ...status(true), login: { phase: "connected", code: null } });
    });
    const hook = renderHook(() => usePiSetup("workspace"));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    vi.useFakeTimers();
    act(() => {
      void hook.result.current.refresh();
    });
    await act(async () => {
      await hook.result.current.login();
    });
    expect(hook.result.current.status?.login.phase).toBe("waiting");
    await act(async () => beforeLogin.resolve(status()));
    expect(hook.result.current.status?.login.phase).toBe("waiting");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(hook.result.current.status?.login.phase).toBe("connected");
    await act(async () =>
      duringLogin.resolve({ ...status(), login: { phase: "waiting", code: null } }),
    );
    expect(hook.result.current.status?.login.phase).toBe("connected");
    expect(hook.result.current.status?.configured).toBe(true);
    expect(hook.result.current.checking).toBe(false);
    expect(reads).toBe(4);
  });

  it.each([
    "success",
    "failure",
  ] as const)("keeps a new workspace check pending when an old check finishes with %s", async (outcome) => {
    const previous = deferredStatus();
    const fresh = deferredStatus();
    native.invoke.mockImplementation((_name, args) =>
      args.cwd === "first" ? previous.promise : fresh.promise,
    );
    const hook = renderHook(({ cwd }) => usePiSetup(cwd), { initialProps: { cwd: "first" } });
    hook.rerender({ cwd: "second" });
    await act(async () =>
      outcome === "success"
        ? previous.resolve(status(true))
        : previous.reject(new Error("authentication_required")),
    );
    expect(hook.result.current.checking).toBe(true);
    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.status).toBeNull();
    expect(hook.result.current.error).toBeNull();
    await act(async () => fresh.resolve(status()));
    expect(hook.result.current.checking).toBe(false);
    expect(hook.result.current.status?.configured).toBe(false);
  });
  it("accepts only the named development presets without granting them to old settings", () => {
    const commands = ["git-status", "git-diff", "project-check", "project-test", "project-build"];
    expect(parsePiSetup(status())?.permissions.commands).toEqual([]);
    expect(
      parsePiSetup({
        ...status(),
        permissions: { read: true, write: false, commands },
      })?.permissions.commands,
    ).toEqual(commands);
    for (const rejected of [
      ["git-status", "git-status"],
      ["git-commit"],
      ["project-deploy"],
      ["npm test"],
      [{ program: "git", args: ["status"] }],
    ]) {
      expect(
        parsePiSetup({
          ...status(),
          permissions: { read: true, write: false, commands: rejected },
        }),
      ).toBeNull();
    }
  });

  it("rejects private fields, unknown phases and malformed permission flags", () => {
    expect(parsePiSetup(status())).toBeTruthy();
    expect(parsePiSetup({ ...status(), token: "PRIVATE" })).toBeNull();
    expect(
      parsePiSetup({ ...status(), permissions: { read: "true", write: false, commands: [] } }),
    ).toBeNull();
    expect(
      parsePiSetup({
        ...status(),
        permissions: { read: true, write: false, commands: ["arbitrary-shell"] },
      }),
    ).toBeNull();
    expect(parsePiLogin({ phase: "waiting", code: null, url: "PRIVATE" })).toBeNull();
    expect(parsePiLogin({ phase: "unknown", code: null })).toBeNull();
    expect(parsePiLogin({ phase: "error", code: "PRIVATE" })).toBeNull();
  });
  it("ignores a previous workspace status arriving after the new workspace", async () => {
    let finish: (value: PiSetupStatus) => void = () => {};
    native.invoke.mockImplementation((_name, args) =>
      args?.cwd === "first"
        ? new Promise<PiSetupStatus>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(status(true)),
    );
    const hook = renderHook(({ cwd }) => usePiSetup(cwd), { initialProps: { cwd: "first" } });
    hook.rerender({ cwd: "second" });
    await waitFor(() => expect(hook.result.current.status?.configured).toBe(true));
    await act(async () => finish(status(false)));
    expect(hook.result.current.status?.configured).toBe(true);
  });
  it.each([
    "workspace change",
    "unmount",
  ] as const)("suppresses save completion after %s while announcing persisted configuration", async (change) => {
    let finish: (value: PiSetupStatus) => void = () => {};
    native.invoke.mockImplementation((name) =>
      name === "continuity_pi_setup_save"
        ? new Promise<PiSetupStatus>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(status(false)),
    );
    const configured = vi.fn();
    window.addEventListener("yorishiro:pi-configured", configured);
    const hook = renderHook(({ cwd }) => usePiSetup(cwd), { initialProps: { cwd: "first" } });
    await waitFor(() => expect(hook.result.current.status).not.toBeNull());
    const settings: PiSettings = {
      version: 2,
      enabled: true,
      provider: "openai",
      model: "model",
      authMode: "oauth",
      permissions: { read: true, write: true, commands: [] },
    };
    let completion: Promise<boolean> = Promise.resolve(true);
    act(() => {
      completion = hook.result.current.save(settings);
    });
    if (change === "workspace change") {
      hook.rerender({ cwd: "second" });
      await waitFor(() => expect(hook.result.current.status?.configured).toBe(false));
    } else {
      hook.unmount();
    }
    let saved = true;
    await act(async () => {
      finish(status(true));
      saved = await completion;
    });
    expect(saved).toBe(false);
    expect(configured).toHaveBeenCalledTimes(1);
    if (change === "workspace change") {
      expect(hook.result.current.status?.configured).toBe(false);
      expect(hook.result.current.status?.permissions.write).toBe(false);
      expect(hook.result.current.error).toBeNull();
    }
    window.removeEventListener("yorishiro:pi-configured", configured);
  });
  it("does not show a previous workspace save error in the new workspace", async () => {
    let fail: (reason: Error) => void = () => {};
    native.invoke.mockImplementation((name) =>
      name === "continuity_pi_setup_save"
        ? new Promise<PiSetupStatus>((_resolve, reject) => {
            fail = reject;
          })
        : Promise.resolve(status(false)),
    );
    const hook = renderHook(({ cwd }) => usePiSetup(cwd), { initialProps: { cwd: "first" } });
    await waitFor(() => expect(hook.result.current.status).not.toBeNull());
    let completion: Promise<boolean> = Promise.resolve(true);
    act(() => {
      completion = hook.result.current.save({
        version: 2,
        enabled: true,
        provider: "openai",
        model: "model",
        authMode: "oauth",
        permissions: { read: true, write: false, commands: [] },
      });
    });
    hook.rerender({ cwd: "second" });
    await waitFor(() => expect(hook.result.current.status).not.toBeNull());
    await act(async () => {
      fail(new Error("authentication_required"));
      expect(await completion).toBe(false);
    });
    expect(hook.result.current.error).toBeNull();
  });
});

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
beforeEach(() => native.invoke.mockReset());
afterEach(() => cleanup());
describe("Pi setup bridge", () => {
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

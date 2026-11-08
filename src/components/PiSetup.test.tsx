// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiSetupStatus } from "../runtime/continuity/pi-setup";
import { PiSetup } from "./PiSetup";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
let current: PiSetupStatus;
const initial = (): PiSetupStatus => ({
  runtimeReady: true,
  configured: false,
  legacyConfiguration: false,
  authenticated: false,
  authentication: "missing",
  model: "fixture-model",
  models: [{ id: "fixture-model", name: "Fixture" }],
  permissions: { read: true, write: false, commands: [] },
  workspaceAvailable: true,
  login: { phase: "idle", code: null },
  code: null,
});
beforeEach(() => {
  current = initial();
  native.invoke.mockReset();
  native.invoke.mockImplementation(async (name, args) => {
    if (name === "continuity_pi_setup_status") return current;
    if (name === "continuity_pi_login_start") {
      current = { ...current, login: { phase: "waiting", code: null } };
      return current.login;
    }
    if (name === "continuity_pi_login_cancel") {
      current = { ...current, login: { phase: "cancelled", code: "login_cancelled" } };
      return current.login;
    }
    if (name === "continuity_pi_login_status") return current.login;
    if (name === "continuity_pi_setup_save") {
      current = { ...current, configured: true, permissions: args.settings.permissions };
      return current;
    }
    throw new Error("unexpected command");
  });
});
afterEach(() => cleanup());

describe("Pi setup", () => {
  it.each([
    [
      "en",
      [
        "Read Git status",
        "Read Git diff",
        "Run project checks",
        "Run project tests",
        "Run project build",
      ],
      "Even with file changes turned Off",
    ],
    [
      "ja",
      [
        "Gitの状態を読む",
        "Gitの差分を読む",
        "プロジェクトの検証を実行する",
        "プロジェクトのテストを実行する",
        "プロジェクトのビルドを実行する",
      ],
      "ファイル変更の許可がOffでも",
    ],
  ] as const)("offers development commands as separate unchecked grants in %s", async (language, labels, explanation) => {
    current = {
      ...initial(),
      configured: true,
      authenticated: true,
      authentication: "present",
      permissions: { read: true, write: false, commands: ["workspace-info"] },
    };
    render(<PiSetup cwd="existing worktree" language={language} />);
    fireEvent.click(
      await screen.findByRole("button", { name: language === "en" ? "Settings" : "設定" }),
    );
    for (const label of labels)
      expect(screen.getByRole("checkbox", { name: label })).toHaveProperty("checked", false);
    expect(screen.getByText(new RegExp(explanation))).toBeTruthy();
    const developmentCheckbox = screen.getByRole("checkbox", { name: labels[2] });
    expect(developmentCheckbox.getAttribute("aria-describedby")).toBeTruthy();
    expect(native.invoke.mock.calls.some(([name]) => name === "continuity_pi_setup_save")).toBe(
      false,
    );
  });

  it("saves only explicitly selected development commands and supports removing a grant", async () => {
    current = {
      ...initial(),
      configured: true,
      authenticated: true,
      authentication: "present",
      permissions: { read: true, write: false, commands: ["workspace-info", "project-build"] },
    };
    render(<PiSetup cwd="existing worktree" language="en" />);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const build = screen.getByRole("checkbox", { name: "Run project build" });
    await waitFor(() => expect(build).toHaveProperty("checked", true));
    fireEvent.click(build);
    fireEvent.click(screen.getByRole("checkbox", { name: "Read Git status" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Run project tests" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and use for autonomous execution" }));
    await waitFor(() =>
      expect(native.invoke.mock.calls.some(([name]) => name === "continuity_pi_setup_save")).toBe(
        true,
      ),
    );
    const saved = native.invoke.mock.calls.find(
      ([name]) => name === "continuity_pi_setup_save",
    )?.[1];
    expect(saved.settings.permissions).toEqual({
      read: true,
      write: false,
      commands: ["workspace-info", "git-status", "project-test"],
    });
    expect(JSON.stringify(saved.settings)).not.toMatch(
      /nodePath|workerEntry|authPath|program|argv/,
    );
  });

  it("requires sign-in and an explicit permissions save without path inputs", async () => {
    const ready = vi.fn();
    render(<PiSetup cwd="workspace fixture" language="ja" onReadinessChange={ready} />);
    await screen.findByRole("button", { name: "OpenAIにログイン" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "ファイルを読む" })).toHaveProperty(
      "checked",
      true,
    );
    expect(screen.getByRole("checkbox", { name: "ファイルを作成・変更する" })).toHaveProperty(
      "checked",
      false,
    );
    expect(screen.getByRole("button", { name: "設定を保存して自律実行に使用" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "ファイルを作成・変更する" }));
    expect(native.invoke.mock.calls.some(([name]) => name === "continuity_pi_setup_save")).toBe(
      false,
    );
    expect(ready).toHaveBeenLastCalledWith(false);
  });

  it("polls browser completion, preserves reviewed choices, then saves path-free settings", async () => {
    const ready = vi.fn();
    const configured = vi.fn();
    render(
      <PiSetup
        cwd="workspace fixture"
        language="en"
        onReadinessChange={ready}
        onConfigured={configured}
      />,
    );
    fireEvent.click(await screen.findByRole("checkbox", { name: "Create and change files" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in to OpenAI" }));
    await screen.findByRole("button", { name: "Cancel sign-in" });
    expect(
      screen.getByRole("button", { name: "Save and use for autonomous execution" }),
    ).toHaveProperty("disabled", true);
    current = {
      ...current,
      authenticated: true,
      authentication: "present",
      login: { phase: "connected", code: null },
    };
    await screen.findByText("Sign-in information is available.", {}, { timeout: 2500 });
    expect(ready).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("checkbox", { name: "Create and change files" })).toHaveProperty(
      "checked",
      true,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Validate JSON files" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and use for autonomous execution" }));
    await waitFor(() => expect(configured).toHaveBeenCalledTimes(1));
    const call = native.invoke.mock.calls.find(([name]) => name === "continuity_pi_setup_save");
    expect(call?.[1]).toEqual({
      cwd: "workspace fixture",
      settings: {
        version: 2,
        enabled: true,
        provider: "openai",
        model: "fixture-model",
        authMode: "oauth",
        permissions: { read: true, write: true, commands: ["validate-json"] },
      },
    });
    expect(JSON.stringify(call?.[1].settings)).not.toMatch(
      /nodePath|workerEntry|authPath|program|argv/,
    );
    expect(ready).toHaveBeenLastCalledWith(true);
  });

  it("cancels login without saving permissions or enabling execution", async () => {
    render(<PiSetup cwd="workspace fixture" language="en" />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in to OpenAI" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel sign-in" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toBe("Sign-in cancelled.");
    expect(native.invoke.mock.calls.some(([name]) => name === "continuity_pi_setup_save")).toBe(
      false,
    );
  });

  it("fails closed on an older or malformed host and hides private errors", async () => {
    native.invoke.mockRejectedValue("PRIVATE path and token");
    const ready = vi.fn();
    render(<PiSetup cwd={null} language="en" onReadinessChange={ready} />);
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("Please update");
    expect(document.body.textContent).not.toContain("PRIVATE");
    expect(screen.queryByRole("button", { name: "Sign in to OpenAI" })).toBeNull();
    expect(ready).toHaveBeenLastCalledWith(false);
  });

  it("shows existing configuration compactly and requires explicit editing", async () => {
    current = { ...current, configured: true, authenticated: true, authentication: "present" };
    render(<PiSetup cwd="workspace fixture" language="en" />);
    await screen.findByText("Configured");
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("combobox", { name: "Model" })).toBeTruthy();
    expect(
      native.invoke.mock.calls.some(
        ([name]) => name === "continuity_pi_login_start" || name === "continuity_pi_setup_save",
      ),
    ).toBe(false);
  });
});

it("requires a fresh permission review when the selected workspace changes", async () => {
  current = {
    ...initial(),
    configured: true,
    authenticated: true,
    authentication: "present",
    permissions: {
      read: true,
      write: true,
      commands: ["workspace-info", "git-status", "project-test"],
    },
  };
  const readiness = vi.fn();
  const view = render(<PiSetup cwd="project a" language="en" onReadinessChange={readiness} />);
  await screen.findByText("Configured");
  current = { ...initial(), authenticated: true, authentication: "present" };
  view.rerender(<PiSetup cwd="project b" language="en" onReadinessChange={readiness} />);
  await screen.findByRole("checkbox", { name: "Create and change files" });
  expect(screen.getByRole("checkbox", { name: "Create and change files" })).toHaveProperty(
    "checked",
    false,
  );
  expect(screen.getByRole("checkbox", { name: "Inspect the workspace overview" })).toHaveProperty(
    "checked",
    false,
  );
  expect(screen.getByRole("checkbox", { name: "Read Git status" })).toHaveProperty(
    "checked",
    false,
  );
  expect(screen.getByRole("checkbox", { name: "Run project tests" })).toHaveProperty(
    "checked",
    false,
  );
  expect(readiness).toHaveBeenLastCalledWith(false);
  expect(native.invoke.mock.calls.some(([name]) => name === "continuity_pi_setup_save")).toBe(
    false,
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Create and change files" }));
  fireEvent.click(screen.getByRole("button", { name: "Save and use for autonomous execution" }));
  await waitFor(() =>
    expect(
      native.invoke.mock.calls.some(
        ([name, args]) => name === "continuity_pi_setup_save" && args.cwd === "project b",
      ),
    ).toBe(true),
  );
});

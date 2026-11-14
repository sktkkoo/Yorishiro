// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      "Recheck connection status",
      "Checking connection status…",
      "Model",
      "Create and change files",
    ],
    [
      "ja",
      "接続状態を再確認",
      "接続状態を確認しています…",
      "使用するモデル",
      "ファイルを作成・変更する",
    ],
  ] as const)("shows pending recheck in %s without replacing unsaved controls, and allows retry after failure", async (language, recheck, checking, modelLabel, writeLabel) => {
    current = {
      ...initial(),
      authenticated: true,
      authentication: "present",
      models: [...initial().models, { id: "chosen-model", name: "Chosen" }],
    };
    render(<PiSetup cwd="workspace fixture" language={language} />);
    const model = await screen.findByRole("combobox", { name: modelLabel });
    const write = screen.getByRole("checkbox", { name: writeLabel });
    fireEvent.change(model, { target: { value: "chosen-model" } });
    fireEvent.click(write);
    let reject!: (cause: Error) => void;
    native.invoke.mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    const button = screen.getByRole("button", { name: recheck });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: checking })).toBe(button);
    expect(button).toHaveProperty("disabled", true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe(checking);
    expect(screen.getByRole("combobox", { name: modelLabel })).toBe(model);
    expect(model).toHaveProperty("value", "chosen-model");
    expect(write).toHaveProperty("checked", true);
    expect(native.invoke).toHaveBeenCalledTimes(2);
    await act(async () => reject(new Error("PRIVATE host detail")));
    expect(screen.getByRole("button", { name: recheck })).toHaveProperty("disabled", false);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(document.body.textContent).not.toContain("PRIVATE host detail");
    await act(async () => fireEvent.click(button));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: recheck })).toHaveProperty("disabled", false);
    expect(model).toHaveProperty("value", "chosen-model");
    expect(write).toHaveProperty("checked", true);
    expect(native.invoke.mock.calls.map(([name]) => name)).toEqual([
      "continuity_pi_setup_status",
      "continuity_pi_setup_status",
      "continuity_pi_setup_status",
    ]);
  });

  it("initializes a newly available model without discarding reviewed permissions", async () => {
    current = { ...initial(), model: "", models: [] };
    render(<PiSetup cwd="workspace fixture" language="en" />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Create and change files" }));
    current = { ...initial(), authenticated: true, authentication: "present" };
    fireEvent(window, new Event("focus"));
    await screen.findByText("Sign-in information is available.");
    const save = screen.getByRole("button", { name: "Save and use for autonomous execution" });
    await waitFor(() => expect(save).toHaveProperty("disabled", false));
    expect(screen.getByRole("checkbox", { name: "Create and change files" })).toHaveProperty(
      "checked",
      true,
    );
    fireEvent.click(save);
    await waitFor(() =>
      expect(native.invoke.mock.calls.some(([name]) => name === "continuity_pi_setup_save")).toBe(
        true,
      ),
    );
    const settings = native.invoke.mock.calls.find(
      ([name]) => name === "continuity_pi_setup_save",
    )?.[1].settings;
    expect(settings.model).toBe("fixture-model");
    expect(settings.permissions.write).toBe(true);
  });

  it("preserves an explicit model selection and permission edits across a status refresh", async () => {
    current = {
      ...initial(),
      authenticated: true,
      authentication: "present",
      models: [
        { id: "fixture-model", name: "Fixture" },
        { id: "chosen-model", name: "Chosen" },
      ],
    };
    render(<PiSetup cwd="workspace fixture" language="en" />);
    const model = await screen.findByRole("combobox", { name: "Model" });
    fireEvent.change(model, { target: { value: "chosen-model" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Create and change files" }));
    current = { ...current, model: "fixture-model" };
    fireEvent(window, new Event("focus"));
    await waitFor(() =>
      expect(
        native.invoke.mock.calls.filter(([name]) => name === "continuity_pi_setup_status"),
      ).toHaveLength(2),
    );
    expect(model).toHaveProperty("value", "chosen-model");
    const save = screen.getByRole("button", { name: "Save and use for autonomous execution" });
    await waitFor(() => expect(save).toHaveProperty("disabled", false));
    fireEvent.click(save);
    await waitFor(() =>
      expect(native.invoke.mock.calls.some(([name]) => name === "continuity_pi_setup_save")).toBe(
        true,
      ),
    );
    const settings = native.invoke.mock.calls.find(
      ([name]) => name === "continuity_pi_setup_save",
    )?.[1].settings;
    expect(settings.model).toBe("chosen-model");
    expect(settings.permissions.write).toBe(true);
  });

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
    await screen.findByRole("checkbox", { name: labels[0] });
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
    await screen.findByRole("combobox", { name: "Model" });
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
    const save = screen.getByRole("button", { name: "Save and use for autonomous execution" });
    await waitFor(() => expect(save).toHaveProperty("disabled", false));
    fireEvent.click(save);
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

  it("refreshes readiness while hidden and retains unsaved edits across manual close", async () => {
    current = { ...current, configured: true, authenticated: true, authentication: "present" };
    const readiness = vi.fn();
    const attention = vi.fn();
    const view = render(
      <PiSetup
        cwd="workspace fixture"
        language="en"
        open={false}
        onReadinessChange={readiness}
        onAttentionChange={attention}
      />,
    );
    await waitFor(() => expect(readiness).toHaveBeenLastCalledWith(true));
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText("Configured")).toBeNull();
    view.rerender(
      <PiSetup
        cwd="workspace fixture"
        language="en"
        open
        onReadinessChange={readiness}
        onAttentionChange={attention}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Create and change files" }));
    view.rerender(
      <PiSetup
        cwd="workspace fixture"
        language="en"
        open={false}
        onReadinessChange={readiness}
        onAttentionChange={attention}
      />,
    );
    current = { ...current, authenticated: false, authentication: "missing" };
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(readiness).toHaveBeenLastCalledWith(false));
    expect(attention).toHaveBeenLastCalledWith(true);
    view.rerender(
      <PiSetup
        cwd="workspace fixture"
        language="en"
        open
        onReadinessChange={readiness}
        onAttentionChange={attention}
      />,
    );
    expect(screen.getByRole("checkbox", { name: "Create and change files" })).toHaveProperty(
      "checked",
      true,
    );
    expect(native.invoke.mock.calls.some(([name]) => name === "continuity_pi_setup_save")).toBe(
      false,
    );
  });

  it("keeps failed saves open and closes only after successful saving", async () => {
    current = { ...current, authenticated: true, authentication: "present" };
    const onClose = vi.fn();
    const onConfigured = vi.fn();
    render(
      <PiSetup
        cwd="workspace fixture"
        language="en"
        onClose={onClose}
        onConfigured={onConfigured}
      />,
    );
    const save = await screen.findByRole("button", {
      name: "Save and use for autonomous execution",
    });
    await waitFor(() => expect(save).toHaveProperty("disabled", false));
    native.invoke.mockRejectedValueOnce("configuration_invalid");
    fireEvent.click(save);
    await screen.findByRole("alert");
    expect(onClose).not.toHaveBeenCalled();
    expect(onConfigured).not.toHaveBeenCalled();
    fireEvent.click(save);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onConfigured).toHaveBeenCalledTimes(1);
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
  await screen.findByRole("combobox", { name: "Model" });
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

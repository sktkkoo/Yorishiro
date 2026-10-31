// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "/test/yorishiro") }));
vi.mock("../bindings/tauri-commands", () => ({ snapshotList: vi.fn(async () => []) }));

function Crash(): never {
  throw new Error("render failed");
}

function renderCrash(
  language: "ja" | "en",
  clipboard?: { writeText: (text: string) => Promise<void> },
) {
  vi.stubGlobal("navigator", {
    clipboard,
    languages: [language],
    platform: "Linux",
    userAgent: "",
  });
  return render(
    <AppErrorBoundary>
      <Crash />
    </AppErrorBoundary>,
  );
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("crash recovery command copy", () => {
  it.each([
    ["en", "Copy safe mode command", "Copying…", "Copied", "Couldn’t copy."],
    [
      "ja",
      "セーフモードのコマンドをコピー",
      "コピー中…",
      "コピーしました",
      "コピーできませんでした。",
    ],
  ] as const)("reports asynchronous failures and retries once at a time in %s", async (language, label, copying, copied, failed) => {
    let rejectCopy!: (error: Error) => void;
    let resolveRetry!: () => void;
    const writeText = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, reject) => {
            rejectCopy = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveRetry = resolve;
          }),
      );
    renderCrash(language, { writeText });
    const button = screen.getByRole("button", { name: label }) as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe(copying);
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("YORISHIRO_SAFE_MODE=1 yorishiro");
    expect(screen.queryByRole("button", { name: copied })).toBeNull();

    await act(async () => rejectCopy(new Error("Clipboard denied")));
    expect(screen.getByRole("alert").textContent).toContain(failed);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe(label);
    expect(screen.getByText("YORISHIRO_SAFE_MODE=1 yorishiro").tagName).toBe("CODE");
    expect(screen.getByText("/test/yorishiro/last-startup.json")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();

    fireEvent.click(button);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledTimes(2);
    await act(async () => resolveRetry());
    expect(button.textContent).toBe(copied);
    expect(button.disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["en", "Copy safe mode command", "Select and copy"],
    ["ja", "セーフモードのコマンドをコピー", "上のコマンドを選択してコピー"],
  ] as const)("keeps the command available when clipboard access is missing in %s", async (language, label, hint) => {
    renderCrash(language);
    const button = screen.getByRole("button", { name: label }) as HTMLButtonElement;
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toContain(hint);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe(label);
    expect(screen.getByText("YORISHIRO_SAFE_MODE=1 yorishiro").tagName).toBe("CODE");
  });
});

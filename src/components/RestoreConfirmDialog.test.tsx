// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RestoreConfirmDialog, type RestoreConfirmStrings } from "./RestoreConfirmDialog";

const STRINGS: RestoreConfirmStrings = {
  title: "Restore this snapshot?",
  body: "Restore to {change} ({time}). This full-replaces packs / config.json / init.js and reloads the app.",
  cancel: "Cancel",
  confirm: "Restore",
  restoring: "Restoring...",
  done: "Restored. Reloading...",
  failed: "Restore failed",
  close: "Close",
  retry: "Retry",
};

function renderDialog(overrides: Partial<ComponentProps<typeof RestoreConfirmDialog>> = {}) {
  return render(
    <RestoreConfirmDialog
      seq={7}
      changeText={'Changed "theme"'}
      timeText="2 minutes ago"
      surface="themed"
      strings={STRINGS}
      onClose={vi.fn()}
      onConfirm={vi.fn(async () => {})}
      {...overrides}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RestoreConfirmDialog", () => {
  it("renders confirm state with initial focus on cancel", () => {
    renderDialog();

    expect(screen.getByRole("dialog", { name: STRINGS.title })).toBeTruthy();
    expect(
      screen.getByText(
        'Restore to Changed "theme" (2 minutes ago). This full-replaces packs / config.json / init.js and reloads the app.',
      ),
    ).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: STRINGS.cancel }));
  });

  it("closes with Escape in confirm state", () => {
    const onClose = vi.fn();
    renderDialog({ onClose });

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close with Escape or backdrop while restoring", async () => {
    let resolveRestore!: () => void;
    const onClose = vi.fn();
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRestore = resolve;
        }),
    );
    renderDialog({ onClose, onConfirm });

    fireEvent.click(screen.getByRole("button", { name: STRINGS.confirm }));
    expect(await screen.findByRole("button", { name: STRINGS.restoring })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    const backdrop = document.body.querySelector<HTMLElement>(".restore-confirm-backdrop");
    if (backdrop === null) throw new Error("backdrop not found");
    fireEvent.mouseDown(backdrop);

    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolveRestore();
    });
  });

  it("shows done state after restore succeeds", async () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: STRINGS.confirm }));

    expect(await screen.findByText(STRINGS.done)).toBeTruthy();
  });

  it("shows error state and retry action when restore fails", async () => {
    renderDialog({
      onConfirm: vi.fn(async () => {
        throw new Error("disk is locked");
      }),
    });

    fireEvent.click(screen.getByRole("button", { name: STRINGS.confirm }));

    expect((await screen.findByRole("alert")).textContent).toBe("Restore failed: disk is locked");
    expect(screen.getByRole("button", { name: STRINGS.retry })).toBeTruthy();
    // フォーカス移動は phase 遷移後の passive effect で走るため、findByRole（commit 時点で解決）
    // 直後に同期 assert すると effect flush 前の一瞬を踏んで flaky になる。確定を待つ。
    await waitFor(() =>
      expect(screen.getByRole("button", { name: STRINGS.close })).toBe(document.activeElement),
    );
  });
});

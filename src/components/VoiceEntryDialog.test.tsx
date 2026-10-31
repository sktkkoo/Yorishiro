// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceEntryDialog, type VoiceEntryDialogStrings } from "./VoiceEntryDialog";

const strings: VoiceEntryDialogStrings = {
  title: "GPT Live requires Codex",
  switchBody: "Switch to Codex and start GPT Live?",
  setupBody: "Install Codex and sign in, then select it in Settings.",
  cancel: "Cancel",
  confirmSwitch: "Switch and start",
  openSettings: "Open Settings",
};

afterEach(cleanup);

describe("VoiceEntryDialog", () => {
  it.each(["switch", "setup"] as const)("keeps keyboard focus inside the %s dialog", (mode) => {
    render(
      <VoiceEntryDialog
        mode={mode}
        strings={strings}
        onCancel={vi.fn()}
        onConfirmSwitch={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    const cancel = screen.getByRole("button", { name: strings.cancel });
    const confirm = screen.getByRole("button", {
      name: mode === "switch" ? strings.confirmSwitch : strings.openSettings,
    });
    expect(document.activeElement).toBe(cancel);
    expect(fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(confirm);
    expect(fireEvent.keyDown(confirm, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(cancel);
    expect(fireEvent.keyDown(cancel, { key: "Tab" })).toBe(true);
  });

  it("returns focus to the opener when closed", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    try {
      const { unmount } = render(
        <VoiceEntryDialog
          mode="switch"
          strings={strings}
          onCancel={vi.fn()}
          onConfirmSwitch={vi.fn()}
          onOpenSettings={vi.fn()}
        />,
      );
      unmount();
      expect(document.activeElement).toBe(opener);
    } finally {
      opener.remove();
    }
  });

  it("does not restore focus to an opener that has been removed", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(
      <VoiceEntryDialog
        mode="setup"
        strings={strings}
        onCancel={vi.fn()}
        onConfirmSwitch={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    const focus = vi.spyOn(opener, "focus");
    opener.remove();
    unmount();
    expect(focus).not.toHaveBeenCalled();
  });

  it.each(["switch", "setup"] as const)("cancels %s with Escape without starting voice", (mode) => {
    const onCancel = vi.fn();
    const onConfirmSwitch = vi.fn();
    const onOpenSettings = vi.fn();
    render(
      <VoiceEntryDialog
        mode={mode}
        strings={strings}
        onCancel={onCancel}
        onConfirmSwitch={onConfirmSwitch}
        onOpenSettings={onOpenSettings}
      />,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: strings.cancel }), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirmSwitch).not.toHaveBeenCalled();
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it("only switches after explicit confirmation", () => {
    const onConfirmSwitch = vi.fn();
    render(
      <VoiceEntryDialog
        mode="switch"
        strings={strings}
        onCancel={vi.fn()}
        onConfirmSwitch={onConfirmSwitch}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText(strings.switchBody)).toBeTruthy();
    expect(onConfirmSwitch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: strings.confirmSwitch }));
    expect(onConfirmSwitch).toHaveBeenCalledTimes(1);
  });

  it("cancels without switching", () => {
    const onCancel = vi.fn();
    const onConfirmSwitch = vi.fn();
    render(
      <VoiceEntryDialog
        mode="switch"
        strings={strings}
        onCancel={onCancel}
        onConfirmSwitch={onConfirmSwitch}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: strings.cancel }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirmSwitch).not.toHaveBeenCalled();
  });

  it("guides an unconfigured user to Settings without switching", () => {
    const onOpenSettings = vi.fn();
    const onConfirmSwitch = vi.fn();
    render(
      <VoiceEntryDialog
        mode="setup"
        strings={strings}
        onCancel={vi.fn()}
        onConfirmSwitch={onConfirmSwitch}
        onOpenSettings={onOpenSettings}
      />,
    );

    expect(screen.getByText(strings.setupBody)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.openSettings }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onConfirmSwitch).not.toHaveBeenCalled();
  });
});

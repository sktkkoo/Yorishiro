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

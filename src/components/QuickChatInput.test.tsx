// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickChatInput, type QuickChatInputStrings, QuickVoiceIndicator } from "./QuickChatInput";

const strings: QuickChatInputStrings = {
  placeholder: "Message Yori…",
  inputLabel: "Quick chat",
  send: "Send message",
  close: "Escape to close",
};

afterEach(cleanup);

describe("QuickChatInput", () => {
  it.each([
    "",
    "draft",
  ])("closes without submitting or changing %j via the close button", (value) => {
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    const onChange = vi.fn();
    render(
      <QuickChatInput
        value={value}
        strings={strings}
        onChange={onChange}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: strings.close }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("focuses the input when it appears", () => {
    render(
      <QuickChatInput
        value=""
        strings={strings}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: strings.inputLabel }));
  });

  it("submits a non-empty message with Enter", () => {
    const onSubmit = vi.fn();
    render(
      <QuickChatInput
        value="hello"
        strings={strings}
        onChange={vi.fn()}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("does not submit blank input or an IME composition", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <QuickChatInput
        value=" "
        strings={strings}
        onChange={vi.fn()}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    rerender(
      <QuickChatInput
        value="変換中"
        strings={strings}
        onChange={vi.fn()}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", isComposing: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([
    { key: "Escape", isComposing: true },
    { key: "Enter", keyCode: 229 },
    { key: "Escape", keyCode: 229 },
  ])("leaves IME keystrokes to the input: %j", (keyEvent) => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(
      <QuickChatInput
        value="変換中"
        strings={strings}
        onChange={vi.fn()}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    );

    const input = screen.getByRole("textbox");
    expect(fireEvent.keyDown(input, keyEvent)).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledOnce();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes with Escape", () => {
    const onClose = vi.fn();
    render(
      <QuickChatInput
        value="draft"
        strings={strings}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([strings.send, strings.close])("closes with Escape while %s is focused", (name) => {
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    render(
      <QuickChatInput
        value="draft"
        strings={strings}
        onChange={vi.fn()}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    );
    const button = screen.getByRole("button", { name });
    button.focus();
    fireEvent.keyDown(button, { key: "Escape" });

    expect(onClose).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each(["", " \n "])("keeps sending disabled for a blank draft: %j", (value) => {
    const onSubmit = vi.fn();
    render(
      <QuickChatInput
        value={value}
        strings={strings}
        onChange={vi.fn()}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );

    const send = screen.getByRole<HTMLButtonElement>("button", { name: strings.send });
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    fireEvent.submit(screen.getByRole("dialog"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: strings.close }).disabled).toBe(
      false,
    );
  });
});

describe("QuickVoiceIndicator", () => {
  it("shows the momentary voice state without a backdrop", () => {
    render(
      <QuickVoiceIndicator
        status="active"
        muted={false}
        connectingLabel="Connecting…"
        activeLabel="Listening…"
        mutedLabel="Muted"
        errorLabel="Voice unavailable"
        muteLabel="Mute microphone"
        unmuteLabel="Unmute microphone"
        shortcutMuteLabel="Command to mute"
        shortcutUnmuteLabel="Command to unmute"
        stopLabel="End voice conversation"
        onToggleMuted={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain("Listening…");
    expect(document.querySelector(".restore-confirm-backdrop")).toBeNull();
  });

  it("offers explicit mute and stop controls", () => {
    const onToggleMuted = vi.fn();
    const onStop = vi.fn();
    render(
      <QuickVoiceIndicator
        status="active"
        muted
        connectingLabel="Connecting…"
        activeLabel="Listening…"
        mutedLabel="Muted"
        errorLabel="Voice unavailable"
        muteLabel="Mute microphone"
        unmuteLabel="Unmute microphone"
        shortcutMuteLabel="Command to mute"
        shortcutUnmuteLabel="Command to unmute"
        stopLabel="End voice conversation"
        onToggleMuted={onToggleMuted}
        onStop={onStop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Unmute microphone" }));
    fireEvent.click(screen.getByRole("button", { name: "End voice conversation" }));
    expect(onToggleMuted).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledOnce();
    expect(screen.getByRole("status").textContent).toContain("Command to unmute");
  });
});

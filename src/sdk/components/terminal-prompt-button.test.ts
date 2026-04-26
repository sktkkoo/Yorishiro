import { describe, expect, it, vi } from "vitest";

import { performTerminalPromptWrite } from "./terminal-prompt-button";

describe("performTerminalPromptWrite", () => {
  it("calls ptyWrite with the exact text (no trailing newline)", async () => {
    const ptyWrite = vi.fn().mockResolvedValue(undefined);
    await performTerminalPromptWrite({
      text: "/charminal:charm 試したい",
      ptyWrite,
      closeActiveUi: undefined,
    });
    expect(ptyWrite).toHaveBeenCalledTimes(1);
    expect(ptyWrite).toHaveBeenCalledWith({ data: "/charminal:charm 試したい" });
  });

  it("closes active UI before writing when closeActiveUi is provided", async () => {
    const calls: string[] = [];
    const closeActiveUi = vi.fn(() => {
      calls.push("close");
    });
    const ptyWrite = vi.fn(async () => {
      calls.push("write");
    });
    await performTerminalPromptWrite({
      text: "test",
      ptyWrite,
      closeActiveUi,
    });
    expect(calls).toEqual(["close", "write"]);
  });

  it("returns the error reason when ptyWrite rejects", async () => {
    const ptyWrite = vi.fn().mockRejectedValue(new Error("PTY not running"));
    const result = await performTerminalPromptWrite({
      text: "test",
      ptyWrite,
      closeActiveUi: undefined,
    });
    expect(result).toEqual({ ok: false, reason: "PTY not running" });
  });

  it("returns ok:true on success", async () => {
    const ptyWrite = vi.fn().mockResolvedValue(undefined);
    const result = await performTerminalPromptWrite({
      text: "test",
      ptyWrite,
      closeActiveUi: undefined,
    });
    expect(result).toEqual({ ok: true });
  });
});

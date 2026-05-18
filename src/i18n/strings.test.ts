import { describe, expect, it } from "vitest";

import { resolveFixedTerminalPrompt } from "./strings";

describe("resolveFixedTerminalPrompt", () => {
  it("resolves the shortcut prompt per language", () => {
    expect(resolveFixedTerminalPrompt("shortcut", "en")).toBe(
      "/charm:shortcut I want to change keyboard shortcuts",
    );
    expect(resolveFixedTerminalPrompt("shortcut", "ja")).toBe(
      "/charm:shortcut ショートカットを変更したい",
    );
  });

  // セキュリティ不変条件: 固定プロンプトは改行を含まない。改行が混ざると
  // user の Enter を待たずに実行されうる（input-prefill-boundary.md / §1）。
  it("never contains a newline or carriage return", () => {
    for (const language of ["en", "ja"] as const) {
      const data = resolveFixedTerminalPrompt("shortcut", language);
      expect(data).not.toMatch(/[\n\r]/);
    }
  });
});

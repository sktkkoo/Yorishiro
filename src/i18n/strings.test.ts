import { describe, expect, it } from "vitest";

import { resolveFixedTerminalPrompt } from "./strings";

const FIXED_PROMPT_KEYS = ["help", "tutorial", "shortcut", "create-pack", "pomodoro"] as const;

describe("resolveFixedTerminalPrompt", () => {
  it("resolves fixed prompts per language", () => {
    expect(FIXED_PROMPT_KEYS.map((key) => [key, resolveFixedTerminalPrompt(key, "en")])).toEqual([
      ["help", "/charm:help"],
      ["tutorial", "/charm:tutorial"],
      ["shortcut", "/charm:shortcut I want to change keyboard shortcuts"],
      ["create-pack", "/charm:create I want to create a pack"],
      ["pomodoro", "/charm:help I want to use Pomodoro"],
    ]);
    expect(FIXED_PROMPT_KEYS.map((key) => [key, resolveFixedTerminalPrompt(key, "ja")])).toEqual([
      ["help", "/charm:help"],
      ["tutorial", "/charm:tutorial"],
      ["shortcut", "/charm:shortcut ショートカットを変更したい"],
      ["create-pack", "/charm:create pack を作りたい"],
      ["pomodoro", "/charm:help Pomodoro を使いたい"],
    ]);
  });

  // セキュリティ不変条件: 固定プロンプトは改行を含まない。改行が混ざると
  // user の Enter を待たずに実行されうる（input-prefill-boundary.md / §1）。
  it("never contains a newline or carriage return", () => {
    for (const language of ["en", "ja"] as const) {
      for (const key of FIXED_PROMPT_KEYS) {
        const data = resolveFixedTerminalPrompt(key, language);
        expect(data).not.toMatch(/[\n\r]/);
      }
    }
  });
});

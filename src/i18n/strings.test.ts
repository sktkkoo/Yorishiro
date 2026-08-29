import { describe, expect, it } from "vitest";

import {
  AGENT_COMMAND_SYNTAX,
  changeStrings,
  getStrings,
  resolveFixedTerminalPrompt,
  resolvePackRepairPrompt,
  restoreConfirmStrings,
} from "./strings";

const FIXED_PROMPT_KEYS = ["help", "tutorial", "shortcut", "create-pack", "pomodoro"] as const;

describe("resolveFixedTerminalPrompt", () => {
  it("resolves fixed prompts per language", () => {
    expect(FIXED_PROMPT_KEYS.map((key) => [key, resolveFixedTerminalPrompt(key, "en")])).toEqual([
      ["help", "/yori:help"],
      ["tutorial", "/yori:tutorial"],
      ["shortcut", "/yori:shortcut I want to change keyboard shortcuts"],
      ["create-pack", "/yori:create I want to create a pack"],
      ["pomodoro", "/yori:help I want to use Pomodoro"],
    ]);
    expect(FIXED_PROMPT_KEYS.map((key) => [key, resolveFixedTerminalPrompt(key, "ja")])).toEqual([
      ["help", "/yori:help"],
      ["tutorial", "/yori:tutorial"],
      ["shortcut", "/yori:shortcut ショートカットを変更したい"],
      ["create-pack", "/yori:create pack を作りたい"],
      ["pomodoro", "/yori:help Pomodoro を使いたい"],
    ]);
  });

  it("resolves Codex fixed prompts as $yori skills", () => {
    expect(
      FIXED_PROMPT_KEYS.map((key) => [key, resolveFixedTerminalPrompt(key, "en", "codex")]),
    ).toEqual([
      ["help", "$yori-help"],
      ["tutorial", "$yori-tutorial"],
      ["shortcut", "$yori-shortcut I want to change keyboard shortcuts"],
      ["create-pack", "$yori-create I want to create a pack"],
      ["pomodoro", "$yori-help I want to use Pomodoro"],
    ]);
  });

  it("resolves OpenCode fixed prompts as /yori-* commands", () => {
    expect(
      FIXED_PROMPT_KEYS.map((key) => [key, resolveFixedTerminalPrompt(key, "en", "opencode")]),
    ).toEqual([
      ["help", "/yori-help"],
      ["tutorial", "/yori-tutorial"],
      ["shortcut", "/yori-shortcut I want to change keyboard shortcuts"],
      ["create-pack", "/yori-create I want to create a pack"],
      ["pomodoro", "/yori-help I want to use Pomodoro"],
    ]);
  });

  it("falls back to Claude command syntax for an unknown agent", () => {
    // 記法 table に無い agent は Claude 形式（/yori:<name>）に fall back する。
    expect(resolveFixedTerminalPrompt("help", "en", "future-agent")).toBe("/yori:help");
    expect(resolveFixedTerminalPrompt("create-pack", "en", "future-agent")).toBe(
      "/yori:create I want to create a pack",
    );
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

describe("View Mode labels", () => {
  it("keeps the null/default selection named Terminal in every locale", () => {
    expect(getStrings("en").terminal).toBe("Terminal");
    expect(getStrings("ja").terminal).toBe("Terminal");
  });
});

describe("AGENT_COMMAND_SYNTAX", () => {
  // Rust 各 adapter の command_syntax() の mirror。ズレると prefill コマンドが
  // 間違った記法になる。Rust↔TS の drift は health-check で runtime 検知される。
  it("mirrors the Rust adapter command syntax", () => {
    expect(AGENT_COMMAND_SYNTAX.claude).toEqual({ prefix: "/", separator: ":" });
    expect(AGENT_COMMAND_SYNTAX.codex).toEqual({ prefix: "$", separator: "-" });
    expect(AGENT_COMMAND_SYNTAX.opencode).toEqual({ prefix: "/", separator: "-" });
  });
});

describe("changeStrings", () => {
  it("builds English ChangeStrings from UiStrings templates", () => {
    const s = changeStrings(getStrings("en"));
    expect(s.changedOnePack("theme")).toBe('Changed "theme"');
    expect(s.changedManyPacks(3)).toBe("3 changes");
    expect(s.changedConfig).toBe("Changed settings");
    expect(s.changedInit).toBe("Changed startup behavior");
    expect(s.changedMixed(2)).toBe("2 changes");
    expect(s.changeStartup).toBe("Startup checkpoint");
    expect(s.changeStartupError).toBe("Startup checkpoint (error)");
    expect(s.changeManual).toBe("Marked by AI");
    expect(s.changeUnknown).toBe("Changed");
  });

  it("builds Japanese ChangeStrings from UiStrings templates", () => {
    const s = changeStrings(getStrings("ja"));
    expect(s.changedOnePack("theme")).toBe("「theme」を変更");
    expect(s.changedManyPacks(3)).toBe("3個の変更");
    expect(s.changedConfig).toBe("設定を変更");
    expect(s.changedInit).toBe("起動時の動作を変更");
    expect(s.changedMixed(2)).toBe("2件の変更");
    expect(s.changeStartup).toBe("起動時チェックポイント");
    expect(s.changeStartupError).toBe("起動時チェックポイント（エラー）");
    expect(s.changeManual).toBe("AIが記録");
    expect(s.changeUnknown).toBe("変更");
  });

  it("keeps Motion Intensity labels aligned across supported UI languages", () => {
    expect(getStrings("en").motionIntensity).toBe("Motion Intensity");
    expect(getStrings("ja").motionIntensity).toBe("Motion Intensity");
    expect(getStrings("en").motionLevelOver).toBe("Over-the-top");
    expect(getStrings("ja").motionLevelOver).toBe("オーバー");
  });

  it("labels the independent voice volume control in both languages", () => {
    expect(getStrings("en").ambientVolume).toBe("Ambient Sound");
    expect(getStrings("en").voiceVolume).toBe("Voice");
    expect(getStrings("en").muteVoice).toBe("Mute voice");
    expect(getStrings("en").unmuteVoice).toBe("Unmute voice");
    expect(getStrings("ja").ambientVolume).toBe("環境音");
    expect(getStrings("ja").voiceVolume).toBe("音声");
    expect(getStrings("ja").muteVoice).toBe("音声をミュート");
    expect(getStrings("ja").unmuteVoice).toBe("音声のミュートを解除");
  });

  it("uses explicit settings section labels", () => {
    expect(getStrings("en").labelAgent).toBe("Main Agent");
    expect(getStrings("ja").labelAgent).toBe("Main Agent");
    expect(getStrings("en").labelAttentionLight).toBe("Light Alert");
    expect(getStrings("ja").labelAttentionLight).toBe("Light Alert");
    expect(getStrings("en").labelRestore).toBe("Restore (Pack / init.js)");
    expect(getStrings("ja").labelRestore).toBe("復元（Pack / init.js）");
    expect(getStrings("en").defaultFolderName).toBe("~");
    expect(getStrings("ja").defaultFolderName).toBe("~");
  });

  it("keeps the fresh Main Agent conversation label concise", () => {
    expect(getStrings("en").newConversation).toBe("New session");
    expect(getStrings("ja").newConversation).toBe("新しいセッション");
  });

  it("labels back/forward session navigation in both languages", () => {
    expect(getStrings("en").backConversation).toBe("Back to previous session");
    expect(getStrings("ja").backConversation).toBe("前のセッションに戻る");
    expect(getStrings("en").forwardConversation).toBe("Forward to next session");
    expect(getStrings("ja").forwardConversation).toBe("次のセッションに進む");
    expect(getStrings("en").noBackConversation).toBe("No previous session");
    expect(getStrings("en").noForwardConversation).toBe("No next session");
  });

  it("localizes the VRM review and explicit apply flow", () => {
    expect(getStrings("en").vrmImportNew).toBe("Add from file…");
    expect(getStrings("ja").vrmImportNew).toBe("ファイルを追加…");
    expect(getStrings("en").vrmNotSpecified).toBe("Not stated");
    expect(getStrings("ja").vrmNotSpecified).toBe("記載なし");
    expect(getStrings("en").vrmApply).toBe("Switch to this avatar");
    expect(getStrings("ja").vrmApply).toBe("このアバターに切り替える");
    expect(getStrings("en").vrmDialogTitle).toBe("Change avatar");
    expect(getStrings("ja").vrmDialogTitle).toBe("アバターを変更");
    expect(getStrings("en").vrmCreator).toBe("Creator");
    expect(getStrings("ja").vrmCreator).toBe("作者");
    expect(getStrings("en").vrmRemove).toBe("Remove from list…");
    expect(getStrings("ja").vrmRemove).toBe("一覧から削除…");
  });
});

describe("restoreConfirmStrings", () => {
  it("builds overlay copy without app prefix or journal wording", () => {
    for (const language of ["en", "ja"] as const) {
      const ui = getStrings(language);
      const s = restoreConfirmStrings(ui);
      expect(s.title).toBe(ui.restoreConfirmTitle);
      expect(s.title).not.toContain("Yorishiro");
      expect(s.title).not.toMatch(/snapshot/i);
      expect(s.body).not.toMatch(/journal/i);
      expect(s.body).not.toMatch(/config\.json|init\.js|snapshot/i);
      expect(ui.restoreConfirmDetail).not.toMatch(/journal/i);
      expect(ui.restoreConfirmDetail).not.toMatch(/config\.json|init\.js|snapshot/i);
      expect(s.confirm).toBe(ui.restoreConfirmButton);
      expect(s.cancel).toBe(ui.restoreConfirmCancel);
      expect(s.failed).toBe(ui.restoreFailed);
    }
  });
});

describe("resolvePackRepairPrompt", () => {
  it("uses $yori-update for Codex", () => {
    expect(
      resolvePackRepairPrompt({
        id: "broken-effect",
        kind: "effect",
        action: "repair",
        language: "en",
        terminalAgent: "codex",
      }),
    ).toBe(
      '$yori-update Diagnose and repair broken-effect (effect). Start with pack_diagnose({ id: "broken-effect" }).',
    );
  });

  it("uses /yori-update for OpenCode", () => {
    expect(
      resolvePackRepairPrompt({
        id: "broken-effect",
        kind: "effect",
        action: "repair",
        language: "en",
        terminalAgent: "opencode",
      }),
    ).toBe(
      '/yori-update Diagnose and repair broken-effect (effect). Start with pack_diagnose({ id: "broken-effect" }).',
    );
  });
});

import { describe, expect, it } from "vitest";
import { detectScreenAttentionRequest } from "./screen-attention-detector";

const CLAUDE_MODEL_MENU_TAIL = `
 ⚠ 3 MCP servers need authentication · run /mcp
 ▎ Fable 5 is back.
 ▎ Until July 7, you can use up to 50% of your plan's weekly usage limit on Fable 5. If you hit your limit, you can
 ▎ continue on Fable 5 with usage credits. Fable 5 draws down usage faster than Opus 4.8. Learn more
 ▎ (https://support.claude.com/en/articles/15424964-claude-fable-5-promotional-access)
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Select model
   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names,
   specify with --model.
     1. Default (recommended)  Opus 4.8 with 1M context · Best for everyday, complex tasks
     2. Opus                   Opus 4.8 with 1M context · Best for everyday, complex tasks
   ❯ 3. Fable ✔                Fable 5 · Most capable for your hardest and longest-running tasks
     4. Sonnet                 Sonnet 5 · Efficient for routine tasks
     5. Haiku                  Haiku 4.5 · Fastest for quick answers
   ◉ xHigh effort ←/→ to adjust
   Use /fast to turn on Fast mode (Opus 4.8).
   Enter to set as default · s to use this session only · Esc to cancel
`;

const CLAUDE_RUNNING_SPINNER_TAIL = `
 ⚠ 3 MCP servers need authentication · run /mcp
 ▎ Fable 5 is back.
 ▎ Until July 7, you can use up to 50% of your plan's weekly usage limit on Fable 5. If you hit your limit, you can
 ▎ continue on Fable 5 with usage credits. Fable 5 draws down usage faster than Opus 4.8. Learn more
 ▎ (https://support.claude.com/en/articles/15424964-claude-fable-5-promotional-access)
❯ Run exactly this bash command and nothing else: echo hello
✽ Boogieing…
────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  esc to interrupt · ← for agents
`;

// 2026-07-03 の PTY 採取では Bash が auto-allow され実許可 prompt が出なかったため、
// 設計 doc §5 の Yes/No 選択肢 + Bash/run 語彙の合成形を fixture とする。
const SYNTHETIC_BASH_PERMISSION_PROMPT = `
  Claude needs your permission to use Bash
  Bash(cat /etc/hosts)
  Do you want Claude to run this command?

  ❯ 1. Yes
    2. Yes, and don't ask again
    3. No
`;

describe("detectScreenAttentionRequest", () => {
  it("detects Claude Code permission prompts from the screen tail", () => {
    const detection = detectScreenAttentionRequest(SYNTHETIC_BASH_PERMISSION_PROMPT);

    expect(detection).toMatchObject({
      title: "Claude Code",
      kind: "permission-prompt",
    });
    expect(detection?.body).toContain("Claude needs your permission");
  });

  it("detects explicit allow-command prompts", () => {
    const detection = detectScreenAttentionRequest(`
      Do you want to allow this command?
      Bash(git status --short)
      1. Yes
      2. No
    `);

    expect(detection).toMatchObject({
      title: "Agent",
      kind: "permission-prompt",
    });
  });

  it("detects Claude do-you-want-to-run prompts", () => {
    const detection = detectScreenAttentionRequest(`
      Claude wants to run a command:
      Bash(git status --short)
      Do you want Claude to run this command?
      1. Yes
      2. No
    `);

    expect(detection).toMatchObject({
      title: "Claude Code",
      kind: "permission-prompt",
    });
  });

  it("detects generic do-you-want-to-proceed prompts", () => {
    const detection = detectScreenAttentionRequest(`
      Bash(npm run build)
      Do you want to proceed?
      ❯ Yes
        No
    `);

    expect(detection).toMatchObject({
      title: "Agent",
      kind: "permission-prompt",
    });
  });

  it("detects Codex approval prompts", () => {
    const detection = detectScreenAttentionRequest(`
      Codex needs approval to run this command
      npm test -- --run
      Allow command?
    `);

    expect(detection).toMatchObject({
      title: "Codex",
      kind: "permission-prompt",
    });
  });

  it("detects Codex allow-to-run prompts", () => {
    const detection = detectScreenAttentionRequest(`
      Allow Codex to run \`npm test -- --run\`?

      1. Yes
      2. No
    `);

    expect(detection).toMatchObject({
      title: "Codex",
      kind: "permission-prompt",
    });
  });

  it("detects choice menus even when the prompt header scrolled out", () => {
    const detection = detectScreenAttentionRequest(`
      Bash(npm run build)
      command preview line 1
      command preview line 2
      1. Yes
      2. Yes, and don't ask again
      3. No
    `);

    expect(detection).toMatchObject({
      title: "Agent",
      kind: "permission-prompt",
    });
  });

  it("does not treat ordinary output as attention", () => {
    expect(
      detectScreenAttentionRequest(`
        running build...
        permission docs generated successfully
        done
      `),
    ).toBeNull();
  });

  it("does not detect Claude model picker menus as attention", () => {
    expect(detectScreenAttentionRequest(CLAUDE_MODEL_MENU_TAIL)).toBeNull();
  });

  it("does not detect Claude running spinner interrupt hint as attention", () => {
    expect(detectScreenAttentionRequest(CLAUDE_RUNNING_SPINNER_TAIL)).toBeNull();
  });

  it("does not detect quoted Yes/No menus when the choice block is not at the tail bottom", () => {
    expect(
      detectScreenAttentionRequest(`
        Bash(npm run build)
        1. Yes
        2. No
        later build output line 1
        later build output line 2
        later build output line 3
        done
      `),
    ).toBeNull();
  });
});

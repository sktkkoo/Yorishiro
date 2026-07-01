import { describe, expect, it } from "vitest";
import { detectScreenAttentionRequest } from "./screen-attention-detector";

describe("detectScreenAttentionRequest", () => {
  it("detects Claude Code permission prompts from the screen tail", () => {
    const detection = detectScreenAttentionRequest(`
      Claude needs your permission to use Bash
      command: npm run build

      ❯ 1. Yes
        2. Yes, and don't ask again
        3. No
    `);

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

  it("does not treat Codex model selection as approval attention", () => {
    expect(
      detectScreenAttentionRequest(`
        Select model

        ❯ 1. gpt-5-codex high
          2. gpt-5-codex medium
          3. gpt-5

        Enter to select · Esc to cancel
      `),
    ).toBeNull();
  });

  it("does not treat slash command menus as approval attention", () => {
    expect(
      detectScreenAttentionRequest(`
        Slash commands

        ❯ /model   Select model
          /clear   Clear conversation
          /help    Show help

        Enter to select · Esc to cancel
      `),
    ).toBeNull();
  });
});

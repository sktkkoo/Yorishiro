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

  it("does not treat ordinary output as attention", () => {
    expect(
      detectScreenAttentionRequest(`
        running build...
        permission docs generated successfully
        done
      `),
    ).toBeNull();
  });
});

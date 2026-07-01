import { describe, expect, it } from "vitest";
import {
  hookSignalSeq,
  isAttentionResolvingSignal,
  parseHookAttentionSignal,
  parseHookTargetSessionId,
} from "./hook-attention";

describe("hook attention parsing", () => {
  it("treats permission-request as an attention request", () => {
    expect(
      parseHookAttentionSignal(
        JSON.stringify({
          event: "permission-request",
          agent: "codex",
          tool_name: "Bash",
          sessionId: "shell-1",
        }),
      ),
    ).toEqual({
      title: "Codex",
      body: "Permission requested for Bash",
      source: "hook",
      sessionId: "shell-1",
    });
  });

  it("ignores generic notifications that do not ask for input or approval", () => {
    expect(
      parseHookAttentionSignal(
        JSON.stringify({
          event: "notification",
          agent: "codex",
          message: "Task completed",
          sessionId: "shell-1",
        }),
      ),
    ).toBeNull();
  });

  it("keeps input-wait notifications as attention requests", () => {
    expect(
      parseHookAttentionSignal(
        JSON.stringify({
          event: "notification",
          agent: "codex",
          message: "Codex is waiting for your input",
          sessionId: "shell-1",
        }),
      ),
    ).toEqual({
      title: "Codex",
      body: "Codex is waiting for your input",
      source: "hook",
      sessionId: "shell-1",
    });
  });

  it("uses pre-tool-use as an approval-wait resolving signal", () => {
    expect(isAttentionResolvingSignal(JSON.stringify({ event: "pre-tool-use" }))).toBe(true);
    expect(isAttentionResolvingSignal(JSON.stringify({ event: "post-tool-use" }))).toBe(true);
    expect(isAttentionResolvingSignal(JSON.stringify({ event: "permission-request" }))).toBe(false);
  });

  it("parses hook metadata defensively", () => {
    expect(hookSignalSeq(JSON.stringify({ _charminal_seq: 42 }))).toBe(42);
    expect(hookSignalSeq(JSON.stringify({ _charminal_seq: "42" }))).toBeNull();
    expect(parseHookTargetSessionId(JSON.stringify({ sessionId: " shell-1 " }))).toBe("shell-1");
    expect(parseHookTargetSessionId("not json")).toBeNull();
  });
});

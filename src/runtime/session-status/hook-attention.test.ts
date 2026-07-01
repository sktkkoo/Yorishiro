import { describe, expect, it } from "vitest";
import {
  hookSignalSeq,
  isAttentionNotificationMessage,
  isAttentionResolvingSignal,
  isOscAttentionNotificationMessage,
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

  it("ignores generic prompt-ready notifications", () => {
    expect(
      parseHookAttentionSignal(
        JSON.stringify({
          event: "notification",
          agent: "codex",
          message: "Codex is waiting for your input",
          sessionId: "shell-1",
        }),
      ),
    ).toBeNull();
  });

  it("classifies only input or approval notifications as attention-worthy", () => {
    expect(isAttentionNotificationMessage("Task completed")).toBe(false);
    expect(isAttentionNotificationMessage("Build finished successfully")).toBe(false);
    expect(isAttentionNotificationMessage("Codex is waiting for your input")).toBe(false);
    expect(isAttentionNotificationMessage("Permission needed to run Bash(ls)")).toBe(true);
    expect(isAttentionNotificationMessage("Approval required before continuing")).toBe(true);
  });

  it("allows OSC-specific input-wait notification wording", () => {
    expect(isAttentionNotificationMessage("Agent waiting for input")).toBe(false);
    expect(isAttentionNotificationMessage("Claude needs input")).toBe(false);
    expect(isOscAttentionNotificationMessage("Agent waiting for input")).toBe(true);
    expect(isOscAttentionNotificationMessage("Claude needs input")).toBe(true);
    expect(isOscAttentionNotificationMessage("requires approval")).toBe(true);
    expect(isOscAttentionNotificationMessage("Task completed")).toBe(false);
  });

  it("uses pre-tool-use as an approval-wait resolving signal", () => {
    expect(isAttentionResolvingSignal(JSON.stringify({ event: "pre-tool-use" }))).toBe(true);
    expect(isAttentionResolvingSignal(JSON.stringify({ event: "post-tool-use" }))).toBe(true);
    expect(isAttentionResolvingSignal(JSON.stringify({ event: "permission-denied" }))).toBe(true);
    expect(isAttentionResolvingSignal(JSON.stringify({ event: "stop-failure" }))).toBe(true);
    expect(isAttentionResolvingSignal(JSON.stringify({ event: "permission-request" }))).toBe(false);
  });

  it("parses hook metadata defensively", () => {
    expect(hookSignalSeq(JSON.stringify({ _charminal_seq: 42 }))).toBe(42);
    expect(hookSignalSeq(JSON.stringify({ _charminal_seq: "42" }))).toBeNull();
    expect(parseHookTargetSessionId(JSON.stringify({ sessionId: " shell-1 " }))).toBe("shell-1");
    expect(parseHookTargetSessionId("not json")).toBeNull();
  });
});

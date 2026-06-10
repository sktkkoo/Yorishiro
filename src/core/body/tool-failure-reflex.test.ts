import { describe, expect, it } from "vitest";
import { shouldTriggerStartleForToolFailure } from "./tool-failure-reflex";

describe("shouldTriggerStartleForToolFailure", () => {
  it("triggers startle for unknown payloads", () => {
    expect(shouldTriggerStartleForToolFailure(null)).toBe(true);
    expect(shouldTriggerStartleForToolFailure("failed")).toBe(true);
  });

  it("triggers startle for ordinary tool errors", () => {
    expect(
      shouldTriggerStartleForToolFailure({
        tool_name: "Bash",
        error: "command not found: pnpm",
      }),
    ).toBe(true);
  });

  it("does not startle for search no-match control flow", () => {
    expect(
      shouldTriggerStartleForToolFailure({
        tool_name: "Grep",
        error: "No matches found",
      }),
    ).toBe(false);
    expect(
      shouldTriggerStartleForToolFailure({
        tool_name: "Glob",
        tool_response: { stderr: "fatal: unexpected glob backend error" },
      }),
    ).toBe(false);
    expect(
      shouldTriggerStartleForToolFailure({
        tool_name: "Search",
        tool_response: { stdout: "", stderr: "exit code 1" },
      }),
    ).toBe(false);
  });

  it("reads nested tool_response output when classifying search misses", () => {
    expect(
      shouldTriggerStartleForToolFailure({
        tool_name: "Search",
        tool_response: {
          stdout: "",
          stderr: "No results found",
        },
      }),
    ).toBe(false);
  });

  it("does not treat Bash exit 1 as benign just because the message contains exit 1", () => {
    expect(
      shouldTriggerStartleForToolFailure({
        tool_name: "Bash",
        error: "exit code 1",
      }),
    ).toBe(true);
  });
});

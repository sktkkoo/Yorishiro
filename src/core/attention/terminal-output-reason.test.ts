import { describe, expect, it } from "vitest";
import { classifyTerminalOutputAttentionReason } from "./terminal-output-reason";

describe("classifyTerminalOutputAttentionReason", () => {
  it("marks error-like output as diagnostic", () => {
    expect(classifyTerminalOutputAttentionReason("Error: build failed")).toBe("diagnostic");
    expect(classifyTerminalOutputAttentionReason("permission denied")).toBe("diagnostic");
    expect(classifyTerminalOutputAttentionReason("  diagnostic test")).toBe("diagnostic");
  });

  it("marks paths as file-link", () => {
    expect(classifyTerminalOutputAttentionReason("src/App.tsx:1157")).toBe("file-link");
    expect(
      classifyTerminalOutputAttentionReason("./docs/decisions/attention-aura-targets.md"),
    ).toBe("file-link");
  });

  it("uses recent-output as fallback", () => {
    expect(classifyTerminalOutputAttentionReason("Listening on port 1430")).toBe("recent-output");
  });
});

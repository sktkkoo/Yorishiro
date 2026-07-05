import { describe, expect, it } from "vitest";
import {
  compactHomePath,
  formatMainSessionTabLabel,
  formatShellSessionTabLabel,
  truncateMiddle,
} from "./session-tab-labels";

describe("session tab labels", () => {
  it("uses the persona name for the main session", () => {
    expect(formatMainSessionTabLabel("CLAI")).toBe("CLAI");
  });

  it("falls back to Agent when the persona name is blank", () => {
    expect(formatMainSessionTabLabel(" ")).toBe("Agent");
  });

  it("compacts home paths for shell sessions", () => {
    expect(formatShellSessionTabLabel("/Users/alice")).toBe("~");
    expect(formatShellSessionTabLabel("/Users/alice/Yorishiro")).toBe("~/Yorishiro");
    expect(formatShellSessionTabLabel("/home/alice/projects/Yorishiro")).toBe(
      "~/projects/Yorishiro",
    );
  });

  it("keeps already compact paths compact", () => {
    expect(compactHomePath("~/Yorishiro")).toBe("~/Yorishiro");
  });

  it("truncates long labels from the middle", () => {
    expect(truncateMiddle("abcdefghijklmnopqrstuvwxyz", 10)).toBe("abcde…wxyz");
  });
});
